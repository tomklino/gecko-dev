/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = ["UrlbarInput"];

const {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  AppConstants: "resource://gre/modules/AppConstants.jsm",
  BrowserUtils: "resource://gre/modules/BrowserUtils.jsm",
  ExtensionSearchHandler: "resource://gre/modules/ExtensionSearchHandler.jsm",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.jsm",
  ReaderMode: "resource://gre/modules/ReaderMode.jsm",
  Services: "resource://gre/modules/Services.jsm",
  UrlbarController: "resource:///modules/UrlbarController.jsm",
  UrlbarEventBufferer: "resource:///modules/UrlbarEventBufferer.jsm",
  UrlbarPrefs: "resource:///modules/UrlbarPrefs.jsm",
  UrlbarQueryContext: "resource:///modules/UrlbarUtils.jsm",
  UrlbarTokenizer: "resource:///modules/UrlbarTokenizer.jsm",
  UrlbarUtils: "resource:///modules/UrlbarUtils.jsm",
  UrlbarValueFormatter: "resource:///modules/UrlbarValueFormatter.jsm",
  UrlbarView: "resource:///modules/UrlbarView.jsm",
});

XPCOMUtils.defineLazyServiceGetter(this, "ClipboardHelper",
                                   "@mozilla.org/widget/clipboardhelper;1",
                                   "nsIClipboardHelper");

/**
 * Represents the urlbar <textbox>.
 * Also forwards important textbox properties and methods.
 */
class UrlbarInput {
  /**
   * @param {object} options
   *   The initial options for UrlbarInput.
   * @param {object} options.textbox
   *   The <textbox> element.
   * @param {object} options.panel
   *   The <panel> element.
   * @param {UrlbarController} [options.controller]
   *   Optional fake controller to override the built-in UrlbarController.
   *   Intended for use in unit tests only.
   */
  constructor(options = {}) {
    this.textbox = options.textbox;
    this.textbox.clickSelectsAll = UrlbarPrefs.get("clickSelectsAll");

    this.panel = options.panel;
    this.window = this.textbox.ownerGlobal;
    this.document = this.window.document;
    this.controller = options.controller || new UrlbarController({
      browserWindow: this.window,
    });
    this.controller.setInput(this);
    this.view = new UrlbarView(this);
    this.valueIsTyped = false;
    this.userInitiatedFocus = false;
    this.isPrivate = PrivateBrowsingUtils.isWindowPrivate(this.window);
    this.lastQueryContextPromise = Promise.resolve();
    this._actionOverrideKeyCount = 0;
    this._resultForCurrentValue = null;
    this._suppressStartQuery = false;
    this._untrimmedValue = "";

    // Forward textbox methods and properties.
    const METHODS = ["addEventListener", "removeEventListener",
      "setAttribute", "hasAttribute", "removeAttribute", "getAttribute",
      "select"];
    const READ_ONLY_PROPERTIES = ["inputField", "editor"];
    const READ_WRITE_PROPERTIES = ["placeholder", "readOnly",
      "selectionStart", "selectionEnd"];

    for (let method of METHODS) {
      this[method] = (...args) => {
        return this.textbox[method](...args);
      };
    }

    for (let property of READ_ONLY_PROPERTIES) {
      Object.defineProperty(this, property, {
        enumerable: true,
        get() {
          return this.textbox[property];
        },
      });
    }

    for (let property of READ_WRITE_PROPERTIES) {
      Object.defineProperty(this, property, {
        enumerable: true,
        get() {
          return this.textbox[property];
        },
        set(val) {
          return this.textbox[property] = val;
        },
      });
    }

    XPCOMUtils.defineLazyGetter(this, "valueFormatter", () => {
      return new UrlbarValueFormatter(this);
    });

    // The event bufferer handles some events, queues them up, and calls back
    // our handleEvent at the right time.
    this.eventBufferer = new UrlbarEventBufferer(this);
    this.inputField.addEventListener("blur", this.eventBufferer);
    this.inputField.addEventListener("keydown", this.eventBufferer);

    const inputFieldEvents = [
      "focus", "input", "keyup", "mouseover", "paste", "scrollend", "select",
      "overflow", "underflow", "dragstart", "dragover", "drop",
    ];
    for (let name of inputFieldEvents) {
      this.inputField.addEventListener(name, this);
    }

    this.addEventListener("mousedown", this);
    this.view.panel.addEventListener("popupshowing", this);
    this.view.panel.addEventListener("popuphidden", this);

    this.inputField.controllers.insertControllerAt(0, new CopyCutController(this));
    this._initPasteAndGo();
  }

  /**
   * Shortens the given value, usually by removing http:// and trailing slashes,
   * such that calling nsIURIFixup::createFixupURI with the result will produce
   * the same URI.
   *
   * @param {string} val
   *   The string to be trimmed if it appears to be URI
   * @returns {string}
   *   The trimmed string
   */
  trimValue(val) {
    return UrlbarPrefs.get("trimURLs") ? this.window.trimURL(val) : val;
  }

  /**
   * Applies styling to the text in the urlbar input, depending on the text.
   */
  formatValue() {
    this.valueFormatter.update();
  }

  closePopup() {
    this.controller.cancelQuery();
    this.view.close();
  }

  focus() {
    this.inputField.focus();
  }

  blur() {
    this.inputField.blur();
  }

  /**
   * Converts an internal URI (e.g. a wyciwyg URI) into one which we can
   * expose to the user.
   *
   * @param {nsIURI} uri
   *   The URI to be converted
   * @returns {nsIURI}
   *   The converted, exposable URI
   */
  makeURIReadable(uri) {
    // Avoid copying 'about:reader?url=', and always provide the original URI:
    // Reader mode ensures we call createExposableURI itself.
    let readerStrippedURI = ReaderMode.getOriginalUrlObjectForDisplay(uri.displaySpec);
    if (readerStrippedURI) {
      return readerStrippedURI;
    }

    try {
      return Services.uriFixup.createExposableURI(uri);
    } catch (ex) {}

    return uri;
  }

  /**
   * Passes DOM events for the textbox to the _on_<event type> methods.
   * @param {Event} event
   *   DOM event from the <textbox>.
   */
  handleEvent(event) {
    let methodName = "_on_" + event.type;
    if (methodName in this) {
      this[methodName](event);
    } else {
      throw new Error("Unrecognized UrlbarInput event: " + event.type);
    }
  }

  /**
   * Handles an event which would cause a url or text to be opened.
   * XXX the name is currently handleCommand which is compatible with
   * urlbarBindings. However, it is no longer called automatically by autocomplete,
   * See _on_keydown.
   *
   * @param {Event} event The event triggering the open.
   * @param {string} [openWhere] Where we expect the result to be opened.
   * @param {object} [openParams]
   *   The parameters related to where the result will be opened.
   * @param {object} [triggeringPrincipal]
   *   The principal that the action was triggered from.
   */
  handleCommand(event, openWhere, openParams = {}, triggeringPrincipal = null) {
    let isMouseEvent = event instanceof this.window.MouseEvent;
    if (isMouseEvent && event.button == 2) {
      // Do nothing for right clicks.
      return;
    }

    // Determine whether to use the selected one-off search button.  In
    // one-off search buttons parlance, "selected" means that the button
    // has been navigated to via the keyboard.  So we want to use it if
    // the triggering event is not a mouse click -- i.e., it's a Return
    // key -- or if the one-off was mouse-clicked.
    let selectedOneOff;
    if (this.view.isOpen) {
      selectedOneOff = this.view.oneOffSearchButtons.selectedButton;
      if (selectedOneOff &&
          isMouseEvent &&
          event.target != selectedOneOff) {
        selectedOneOff = null;
      }
      // Do the command of the selected one-off if it's not an engine.
      if (selectedOneOff && !selectedOneOff.engine) {
        selectedOneOff.doCommand();
        return;
      }
    }

    // Use the selected result if we have one; this is usually the case
    // when the view is open.
    let index = this.view.selectedIndex;
    if (!selectedOneOff && index != -1) {
      this.pickResult(event, index);
      return;
    }

    let url;
    if (selectedOneOff) {
      // If there's a selected one-off button then load a search using
      // the button's engine.
      let result = this._resultForCurrentValue;
      let searchString =
        (result && (result.payload.suggestion || result.payload.query)) ||
        this._lastSearchString;
      [url, openParams.postData] = UrlbarUtils.getSearchQueryUrl(
        selectedOneOff.engine, searchString);
      this._recordSearch(selectedOneOff.engine, event);
    } else {
      // Use the current value if we don't have a UrlbarResult e.g. because the
      // view is closed.
      url = this.value;
      openParams.postData = null;
    }

    if (!url) {
      return;
    }

    let where = openWhere || this._whereToOpen(event);

    openParams.allowInheritPrincipal = false;

    this.controller.recordSelectedResult(event, index);

    url = this._maybeCanonizeURL(event, url) || url.trim();

    try {
      new URL(url);
    } catch (ex) {
      let browser = this.window.gBrowser.selectedBrowser;
      let lastLocationChange = browser.lastLocationChange;

      UrlbarUtils.getShortcutOrURIAndPostData(url).then(data => {
        if (where != "current" ||
            browser.lastLocationChange == lastLocationChange) {
          openParams.postData = data.postData;
          openParams.allowInheritPrincipal = data.mayInheritPrincipal;
          this._loadURL(data.url, where, openParams);
        }
      });
      return;
    }

    this._loadURL(url, where, openParams);
  }

  handleRevert() {
    this.window.gBrowser.userTypedValue = null;
    this.window.URLBarSetURI(null, true);
    if (this.value && this.focused) {
      this.select();
    }
  }

  /**
   * Called by the view when a result is picked.
   *
   * @param {Event} event The event that picked the result.
   * @param {resultIndex} resultIndex The index of the result that was picked.
   */
  pickResult(event, resultIndex) {
    let result = this.view.getResult(resultIndex);
    this.setValueFromResult(result);

    this.view.close();

    this.controller.recordSelectedResult(event, resultIndex);

    let where = this._whereToOpen(event);
    let {url, postData} = UrlbarUtils.getUrlFromResult(result);
    let openParams = {
      postData,
      allowInheritPrincipal: false,
    };

    if (result.autofill) {
      // For autofilled results, the value that should be canonized is not the
      // autofilled value but the value that the user typed.
      let canonizedUrl = this._maybeCanonizeURL(event, this._lastSearchString);
      if (canonizedUrl) {
        this._loadURL(canonizedUrl, where, openParams);
        return;
      }
    }

    switch (result.type) {
      case UrlbarUtils.RESULT_TYPE.TAB_SWITCH: {
        if (this.hasAttribute("actionoverride")) {
          where = "current";
          break;
        }

        this.handleRevert();
        let prevTab = this.window.gBrowser.selectedTab;
        let loadOpts = {
          adoptIntoActiveWindow: UrlbarPrefs.get("switchTabs.adoptIntoActiveWindow"),
        };

        if (this.window.switchToTabHavingURI(Services.io.newURI(url), false, loadOpts) &&
            prevTab.isEmpty) {
          this.window.gBrowser.removeTab(prevTab);
        }
        return;
      }
      case UrlbarUtils.RESULT_TYPE.SEARCH: {
        let canonizedUrl = this._maybeCanonizeURL(event,
                result.payload.suggestion || result.payload.query);
        if (canonizedUrl) {
          url = canonizedUrl;
          break;
        }
        if (result.payload.isKeywordOffer) {
          // Picking a keyword offer just fills it in the input and doesn't
          // visit anything.  The user can then type a search string.  Also
          // start a new search so that the offer appears in the view by itself
          // to make it even clearer to the user what's going on.
          this.startQuery();
          return;
        }
        const actionDetails = {
          isSuggestion: !!result.payload.suggestion,
          alias: result.payload.keyword,
        };
        const engine = Services.search.getEngineByName(result.payload.engine);
        this._recordSearch(engine, event, actionDetails);
        break;
      }
      case UrlbarUtils.RESULT_TYPE.OMNIBOX: {
        // Give the extension control of handling the command.
        ExtensionSearchHandler.handleInputEntered(result.payload.keyword,
                                                  result.payload.content,
                                                  where);
        return;
      }
    }

    if (!url) {
      throw new Error(`Invalid url for result ${JSON.stringify(result)}`);
    }
    this._loadURL(url, where, openParams);
  }

  /**
   * Called by the view when moving through results with the keyboard.
   *
   * @param {UrlbarResult} result The result that was selected.
   */
  setValueFromResult(result) {
    if (result.autofill) {
      this._setValueFromResultAutofill(result);
    } else {
      this.value = this._valueFromResultPayload(result);
    }
    this._resultForCurrentValue = result;

    // Also update userTypedValue. See bug 287996.
    this.window.gBrowser.userTypedValue = this.value;

    // The value setter clobbers the actiontype attribute, so update this after that.
    switch (result.type) {
      case UrlbarUtils.RESULT_TYPE.TAB_SWITCH:
        this.setAttribute("actiontype", "switchtab");
        break;
      case UrlbarUtils.RESULT_TYPE.OMNIBOX:
        this.setAttribute("actiontype", "extension");
        break;
    }
  }

  /**
   * Starts a query based on the user input.
   *
   * @param {number} [options.lastKey]
   *   The last key the user entered (as a key code).
   */
  startQuery({
    lastKey = null,
  } = {}) {
    if (this._suppressStartQuery) {
      return;
    }

    let searchString = this.textValue;

    // We should autofill only when all of the following are true:
    // * The pref is enabled.
    // * The end of the selection is at the end of the input.
    // * The user hasn't deleted text at the end of the input since the last
    //   query.  Do a simple prefix comparison to guess whether that happened.
    let enableAutofill =
      UrlbarPrefs.get("autoFill") &&
      this.selectionEnd == searchString.length &&
      (!this._lastSearchString ||
       !this._lastSearchString.startsWith(searchString));
    this._lastSearchString = searchString;

    // TODO (Bug 1522902): This promise is necessary for tests, because some
    // tests are not listening for completion when starting a query through
    // other methods than startQuery (input events for example).
    this.lastQueryContextPromise = this.controller.startQuery(new UrlbarQueryContext({
      enableAutofill,
      isPrivate: this.isPrivate,
      lastKey,
      maxResults: UrlbarPrefs.get("maxRichResults"),
      muxer: "UnifiedComplete",
      providers: ["UnifiedComplete"],
      searchString,
    }));
  }

  /**
   * Sets the input's value, starts a search, and opens the popup.
   *
   * @param {string} value
   *   The input's value will be set to this value, and the search will
   *   use it as its query.
   */
  search(value) {
    this.window.focusAndSelectUrlBar();

    // If the value is a restricted token, append a space.
    if (Object.values(UrlbarTokenizer.RESTRICT).includes(value)) {
      this.inputField.value = value + " ";
    } else {
      this.inputField.value = value;
    }

    // Avoid selecting the text if this method is called twice in a row.
    this.selectionStart = -1;

    let event = this.document.createEvent("UIEvents");
    event.initUIEvent("input", true, false, this.window, 0);
    this.inputField.dispatchEvent(event);
  }

  /**
   * Focus without the focus styles.
   * This is used by Activity Stream and about:privatebrowsing for search hand-off.
   */
  setHiddenFocus() {
    this.textbox.classList.add("hidden-focus");
    this.focus();
  }

  /**
   * Remove the hidden focus styles.
   * This is used by Activity Stream and about:privatebrowsing for search hand-off.
   */
  removeHiddenFocus() {
    this.textbox.classList.remove("hidden-focus");
  }

  // Getters and Setters below.

  get focused() {
    return this.textbox.getAttribute("focused") == "true";
  }

  get goButton() {
    return this.document.getAnonymousElementByAttribute(this.textbox, "anonid",
      "urlbar-go-button");
  }

  get textValue() {
    return this.inputField.value;
  }

  get value() {
    return this._untrimmedValue;
  }

  set value(val) {
    this._untrimmedValue = val;

    let originalUrl = ReaderMode.getOriginalUrlObjectForDisplay(val);
    if (originalUrl) {
      val = originalUrl.displaySpec;
    }

    val = this.trimValue(val);

    this.valueIsTyped = false;
    this._resultForCurrentValue = null;
    this.inputField.value = val;
    this.formatValue();
    this.removeAttribute("actiontype");

    // Dispatch ValueChange event for accessibility.
    let event = this.document.createEvent("Events");
    event.initEvent("ValueChange", true, true);
    this.inputField.dispatchEvent(event);

    return val;
  }

  // Private methods below.

  _setValueFromResultAutofill(result) {
    this.value = result.autofill.value;
    this.selectionStart = result.autofill.selectionStart;
    this.selectionEnd = result.autofill.selectionEnd;
  }

  _valueFromResultPayload(result) {
    switch (result.type) {
      case UrlbarUtils.RESULT_TYPE.KEYWORD:
        return result.payload.input;
      case UrlbarUtils.RESULT_TYPE.SEARCH:
        return (result.payload.keyword ? result.payload.keyword + " " : "") +
               (result.payload.suggestion || result.payload.query);
      case UrlbarUtils.RESULT_TYPE.OMNIBOX:
        return result.payload.content;
    }

    try {
      let uri = Services.io.newURI(result.payload.url);
      if (uri) {
        return this.window.losslessDecodeURI(uri);
      }
    } catch (ex) {}

    return "";
  }

  _updateTextOverflow() {
    if (!this._overflowing) {
      this.removeAttribute("textoverflow");
      return;
    }

    this.window.promiseDocumentFlushed(() => {
      // Check overflow again to ensure it didn't change in the meantime.
      let input = this.inputField;
      if (input && this._overflowing) {
        let side = input.scrollLeft &&
                   input.scrollLeft == input.scrollLeftMax ? "start" : "end";
        this.window.requestAnimationFrame(() => {
          // And check once again, since we might have stopped overflowing
          // since the promiseDocumentFlushed callback fired.
          if (this._overflowing) {
            this.setAttribute("textoverflow", side);
          }
        });
      }
    });
  }

  _updateUrlTooltip() {
    if (this.focused || !this._overflowing) {
      this.inputField.removeAttribute("title");
    } else {
      this.inputField.setAttribute("title", this.value);
    }
  }

  _getSelectedValueForClipboard() {
    let selection = this.editor.selection;
    const flags = Ci.nsIDocumentEncoder.OutputPreformatted |
                  Ci.nsIDocumentEncoder.OutputRaw;
    let selectedVal = selection.toStringWithFormat("text/plain", flags, 0);

    // Handle multiple-range selection as a string for simplicity.
    if (selection.rangeCount > 1) {
      return selectedVal;
    }

    // If the selection doesn't start at the beginning or doesn't span the
    // full domain or the URL bar is modified or there is no text at all,
    // nothing else to do here.
    if (this.selectionStart > 0 || this.valueIsTyped || selectedVal == "") {
      return selectedVal;
    }

    // The selection doesn't span the full domain if it doesn't contain a slash and is
    // followed by some character other than a slash.
    if (!selectedVal.includes("/")) {
      let remainder = this.textValue.replace(selectedVal, "");
      if (remainder != "" && remainder[0] != "/") {
        return selectedVal;
      }
    }

    let uri;
    if (this.getAttribute("pageproxystate") == "valid") {
      uri = this.window.gBrowser.currentURI;
    } else {
      // We're dealing with an autocompleted value.
      if (!this._resultForCurrentValue) {
        throw new Error("UrlbarInput: Should have a UrlbarResult since " +
                        "pageproxystate != 'valid' and valueIsTyped == false");
      }
      let resultURL = this._resultForCurrentValue.payload.url;
      if (!resultURL) {
        return selectedVal;
      }

      try {
        uri = Services.uriFixup.createFixupURI(resultURL, Services.uriFixup.FIXUP_FLAG_NONE);
      } catch (e) {}
      if (!uri) {
        return selectedVal;
      }
    }

    uri = this.makeURIReadable(uri);

    // If the entire URL is selected, just use the actual loaded URI,
    // unless we want a decoded URI, or it's a data: or javascript: URI,
    // since those are hard to read when encoded.
    if (this.textValue == selectedVal &&
        !uri.schemeIs("javascript") &&
        !uri.schemeIs("data") &&
        !UrlbarPrefs.get("decodeURLsOnCopy")) {
      return uri.displaySpec;
    }

    // Just the beginning of the URL is selected, or we want a decoded
    // url. First check for a trimmed value.
    let spec = uri.displaySpec;
    let trimmedSpec = this.trimValue(spec);
    if (spec != trimmedSpec) {
      // Prepend the portion that trimValue removed from the beginning.
      // This assumes trimValue will only truncate the URL at
      // the beginning or end (or both).
      let trimmedSegments = spec.split(trimmedSpec);
      selectedVal = trimmedSegments[0] + selectedVal;
    }

    return selectedVal;
  }

  _toggleActionOverride(event) {
    if (event.keyCode == KeyEvent.DOM_VK_SHIFT ||
        event.keyCode == KeyEvent.DOM_VK_ALT ||
        event.keyCode == (AppConstants.platform == "macosx" ?
                            KeyEvent.DOM_VK_META :
                            KeyEvent.DOM_VK_CONTROL)) {
      if (event.type == "keydown") {
        this._actionOverrideKeyCount++;
        this.setAttribute("actionoverride", "true");
        this.view.panel.setAttribute("actionoverride", "true");
      } else if (this._actionOverrideKeyCount &&
                 --this._actionOverrideKeyCount == 0) {
        this.removeAttribute("actionoverride");
        this.view.panel.removeAttribute("actionoverride");
      }
    }
  }

  /**
   * Get the url to load for the search query and records in telemetry that it
   * is being loaded.
   *
   * @param {nsISearchEngine} engine
   *   The engine to generate the query for.
   * @param {Event} event
   *   The event that triggered this query.
   * @param {object} searchActionDetails
   *   The details associated with this search query.
   * @param {boolean} searchActionDetails.isSuggestion
   *   True if this query was initiated from a suggestion from the search engine.
   * @param {alias} searchActionDetails.alias
   *   True if this query was initiated via a search alias.
   */
  _recordSearch(engine, event, searchActionDetails = {}) {
    const isOneOff = this.view.oneOffSearchButtons.maybeRecordTelemetry(event);
    // Infer the type of the event which triggered the search.
    let eventType = "unknown";
    if (event instanceof KeyboardEvent) {
      eventType = "key";
    } else if (event instanceof MouseEvent) {
      eventType = "mouse";
    }
    // Augment the search action details object.
    let details = searchActionDetails;
    details.isOneOff = isOneOff;
    details.type = eventType;

    this.window.BrowserSearch.recordSearchInTelemetry(engine, "urlbar", details);
  }

  /**
   * If appropriate, this prefixes a search string with 'www.' and suffixes it
   * with browser.fixup.alternate.suffix prior to navigating.
   *
   * @param {Event} event
   *   The event that triggered this query.
   * @param {string} value
   *   The search string that should be canonized.
   * @returns {string}
   *   Returns the canonized URL if available and null otherwise.
   */
  _maybeCanonizeURL(event, value) {
    // Only add the suffix when the URL bar value isn't already "URL-like",
    // and only if we get a keyboard event, to match user expectations.
    if (!(event instanceof KeyboardEvent) ||
        !event.ctrlKey ||
        !UrlbarPrefs.get("ctrlCanonizesURLs") ||
        !/^\s*[^.:\/\s]+(?:\/.*|\s*)$/i.test(value)) {
      return null;
    }

    let suffix = Services.prefs.getCharPref("browser.fixup.alternate.suffix");
    if (!suffix.endsWith("/")) {
      suffix += "/";
    }

    // trim leading/trailing spaces (bug 233205)
    value = value.trim();

    // Tack www. and suffix on.  If user has appended directories, insert
    // suffix before them (bug 279035).  Be careful not to get two slashes.
    let firstSlash = value.indexOf("/");
    if (firstSlash >= 0) {
      value = value.substring(0, firstSlash) + suffix +
              value.substring(firstSlash + 1);
    } else {
      value = value + suffix;
    }
    value = "http://www." + value;

    this.value = value;
    return value;
  }

  /**
   * Loads the url in the appropriate place.
   *
   * @param {string} url
   *   The URL to open.
   * @param {string} openUILinkWhere
   *   Where we expect the result to be opened.
   * @param {object} params
   *   The parameters related to how and where the result will be opened.
   *   Further supported paramters are listed in utilityOverlay.js#openUILinkIn.
   * @param {object} params.triggeringPrincipal
   *   The principal that the action was triggered from.
   * @param {nsIInputStream} [params.postData]
   *   The POST data associated with a search submission.
   * @param {boolean} [params.allowInheritPrincipal]
   *   If the principal may be inherited
   */
  _loadURL(url, openUILinkWhere, params) {
    let browser = this.window.gBrowser.selectedBrowser;

    // TODO: These should probably be set by the input field.
    // this.value = url;
    // browser.userTypedValue = url;
    if (this.window.gInitialPages.includes(url)) {
      browser.initialPageLoadedFromUserAction = url;
    }
    try {
      UrlbarUtils.addToUrlbarHistory(url, this.window);
    } catch (ex) {
      // Things may go wrong when adding url to session history,
      // but don't let that interfere with the loading of the url.
      Cu.reportError(ex);
    }

    params.allowThirdPartyFixup = true;

    if (openUILinkWhere == "current") {
      params.targetBrowser = browser;
      params.indicateErrorPageLoad = true;
      params.allowPinnedTabHostChange = true;
      params.allowPopups = url.startsWith("javascript:");
    } else {
      params.initiatingDoc = this.window.document;
    }

    // Focus the content area before triggering loads, since if the load
    // occurs in a new tab, we want focus to be restored to the content
    // area when the current tab is re-selected.
    browser.focus();

    if (openUILinkWhere != "current") {
      this.handleRevert();
    }

    try {
      this.window.openTrustedLinkIn(url, openUILinkWhere, params);
    } catch (ex) {
      // This load can throw an exception in certain cases, which means
      // we'll want to replace the URL with the loaded URL:
      if (ex.result != Cr.NS_ERROR_LOAD_SHOWED_ERRORPAGE) {
        this.handleRevert();
      }
    }

    // TODO This should probably be handed via input.
    // Ensure the start of the URL is visible for usability reasons.
    // this.selectionStart = this.selectionEnd = 0;

    this.closePopup();
  }

  /**
   * Determines where a URL/page should be opened.
   *
   * @param {Event} event the event triggering the opening.
   * @returns {"current" | "tabshifted" | "tab" | "save" | "window"}
   */
  _whereToOpen(event) {
    let isMouseEvent = event instanceof MouseEvent;
    let reuseEmpty = !isMouseEvent;
    let where = undefined;
    if (!isMouseEvent && event && event.altKey) {
      // We support using 'alt' to open in a tab, because ctrl/shift
      // might be used for canonizing URLs:
      where = event.shiftKey ? "tabshifted" : "tab";
    } else if (!isMouseEvent && event && event.ctrlKey &&
               UrlbarPrefs.get("ctrlCanonizesURLs")) {
      // If we're allowing canonization, and this is a key event with ctrl
      // pressed, open in current tab to allow ctrl-enter to canonize URL.
      where = "current";
    } else {
      where = this.window.whereToOpenLink(event, false, false);
    }
    if (UrlbarPrefs.get("openintab")) {
      if (where == "current") {
        where = "tab";
      } else if (where == "tab") {
        where = "current";
      }
      reuseEmpty = true;
    }
    if (where == "tab" &&
        reuseEmpty &&
        this.window.gBrowser.selectedTab.isEmpty) {
      where = "current";
    }
    return where;
  }

  _initPasteAndGo() {
    let inputBox = this.document.getAnonymousElementByAttribute(
                     this.textbox, "anonid", "moz-input-box");
    // Force the Custom Element to upgrade until Bug 1470242 handles this:
    this.window.customElements.upgrade(inputBox);
    let contextMenu = inputBox.menupopup;
    let insertLocation = contextMenu.firstElementChild;
    while (insertLocation.nextElementSibling &&
           insertLocation.getAttribute("cmd") != "cmd_paste") {
      insertLocation = insertLocation.nextElementSibling;
    }
    if (!insertLocation) {
      return;
    }

    let pasteAndGo = this.document.createXULElement("menuitem");
    let label = Services.strings
                        .createBundle("chrome://browser/locale/browser.properties")
                        .GetStringFromName("pasteAndGo.label");
    pasteAndGo.setAttribute("label", label);
    pasteAndGo.setAttribute("anonid", "paste-and-go");
    pasteAndGo.addEventListener("command", () => {
      this._suppressStartQuery = true;

      this.select();
      this.window.goDoCommand("cmd_paste");
      this.handleCommand();

      this._suppressStartQuery = false;
    });

    contextMenu.addEventListener("popupshowing", () => {
      let controller =
        this.document.commandDispatcher.getControllerForCommand("cmd_paste");
      let enabled = controller.isCommandEnabled("cmd_paste");
      if (enabled) {
        pasteAndGo.removeAttribute("disabled");
      } else {
        pasteAndGo.setAttribute("disabled", "true");
      }
    });

    insertLocation.insertAdjacentElement("afterend", pasteAndGo);
  }

  // Event handlers below.

  _on_blur(event) {
    this.formatValue();
    this.closePopup();
  }

  _on_focus(event) {
    this._updateUrlTooltip();

    this.formatValue();
  }

  _on_mouseover(event) {
    this._updateUrlTooltip();
  }

  _on_mousedown(event) {
    if (event.originalTarget == this.inputField &&
        event.button == 0 &&
        event.detail == 2 &&
        UrlbarPrefs.get("doubleClickSelectsAll")) {
      this.editor.selectAll();
      event.preventDefault();
      return;
    }

    if (event.originalTarget.classList.contains("urlbar-history-dropmarker") &&
        event.button == 0) {
      if (this.view.isOpen) {
        this.view.close();
      } else {
        this.startQuery();
      }
    }
  }

  _on_input() {
    let value = this.textValue;
    this.valueIsTyped = true;
    this._untrimmedValue = value;
    this.window.gBrowser.userTypedValue = value;

    if (value) {
      this.setAttribute("usertyping", "true");
    } else {
      this.removeAttribute("usertyping");
    }
    this.removeAttribute("actiontype");

    if (!value && this.view.isOpen) {
      this.view.close();
      return;
    }

    // XXX Fill in lastKey, and add anything else we need.
    this.startQuery({
      lastKey: null,
    });
  }

  _on_select(event) {
    if (!Services.clipboard.supportsSelectionClipboard()) {
      return;
    }

    if (!this.window.windowUtils.isHandlingUserInput) {
      return;
    }

    let val = this._getSelectedValueForClipboard();
    if (!val) {
      return;
    }

    ClipboardHelper.copyStringToClipboard(val, Services.clipboard.kSelectionClipboard);
  }

  _on_overflow(event) {
    const targetIsPlaceholder =
      !event.originalTarget.classList.contains("anonymous-div");
    // We only care about the non-placeholder text.
    // This shouldn't be needed, see bug 1487036.
    if (targetIsPlaceholder) {
      return;
    }
    this._overflowing = true;
    this._updateTextOverflow();
  }

  _on_underflow(event) {
    const targetIsPlaceholder =
      !event.originalTarget.classList.contains("anonymous-div");
    // We only care about the non-placeholder text.
    // This shouldn't be needed, see bug 1487036.
    if (targetIsPlaceholder) {
      return;
    }
    this._overflowing = false;

    this._updateTextOverflow();

    this._updateUrlTooltip();
  }

  _on_paste(event) {
    let originalPasteData = event.clipboardData.getData("text/plain");
    if (!originalPasteData) {
      return;
    }

    let oldValue = this.inputField.value;
    let oldStart = oldValue.substring(0, this.selectionStart);
    // If there is already non-whitespace content in the URL bar
    // preceding the pasted content, it's not necessary to check
    // protocols used by the pasted content:
    if (oldStart.trim()) {
      return;
    }
    let oldEnd = oldValue.substring(this.selectionEnd);

    let pasteData = UrlbarUtils.stripUnsafeProtocolOnPaste(originalPasteData);
    if (originalPasteData != pasteData) {
      // Unfortunately we're not allowed to set the bits being pasted
      // so cancel this event:
      event.preventDefault();
      event.stopImmediatePropagation();

      this.inputField.value = oldStart + pasteData + oldEnd;
      // Fix up cursor/selection:
      let newCursorPos = oldStart.length + pasteData.length;
      this.selectionStart = newCursorPos;
      this.selectionEnd = newCursorPos;
    }
  }

  _on_scrollend(event) {
    this._updateTextOverflow();
  }

  _on_TabSelect(event) {
    this.controller.tabContextChanged();
  }

  _on_keydown(event) {
    this.controller.handleKeyNavigation(event);
    this._toggleActionOverride(event);
  }

  _on_keyup(event) {
    this._toggleActionOverride(event);
  }

  _on_popupshowing() {
    this.setAttribute("open", "true");
  }

  _on_popuphidden() {
    this.removeAttribute("open");
  }

  _on_dragstart(event) {
    // Drag only if the gesture starts from the input field.
    let nodePosition = this.inputField.compareDocumentPosition(event.originalTarget);
    if (this.inputField != event.originalTarget &&
        !(nodePosition & Node.DOCUMENT_POSITION_CONTAINED_BY)) {
      return;
    }

    // Drag only if the entire value is selected and it's a loaded URI.
    if (this.selectionStart != 0 ||
        this.selectionEnd != this.inputField.textLength ||
        this.getAttribute("pageproxystate") != "valid") {
      return;
    }

    let href = this.window.gBrowser.currentURI.displaySpec;
    let title = this.window.gBrowser.contentTitle || href;

    event.dataTransfer.setData("text/x-moz-url", `${href}\n${title}`);
    event.dataTransfer.setData("text/unicode", href);
    event.dataTransfer.setData("text/html", `<a href="${href}">${title}</a>`);
    event.dataTransfer.effectAllowed = "copyLink";
    event.stopPropagation();
  }

  _on_dragover(event) {
    if (!getDroppableData(event)) {
      event.dataTransfer.dropEffect = "none";
    }
  }

  _on_drop(event) {
    let droppedItem = getDroppableData(event);
    if (!droppedItem) {
      return;
    }
    let principal = Services.droppedLinkHandler.getTriggeringPrincipal(event);
    this.value = droppedItem instanceof URL ? droppedItem.href : droppedItem;
    this.window.SetPageProxyState("invalid");
    this.focus();
    this.handleCommand(null, undefined, undefined, principal);
    // For safety reasons, in the drop case we don't want to immediately show
    // the the dropped value, instead we want to keep showing the current page
    // url until an onLocationChange happens.
    // See the handling in URLBarSetURI for further details.
    this.window.gBrowser.userTypedValue = null;
    this.window.URLBarSetURI(null, true);
  }
}

/**
 * Tries to extract droppable data from a DND event.
 * @param {Event} event The DND event to examine.
 * @returns {URL|string|null}
 *          null if there's a security reason for which we should do nothing.
 *          A URL object if it's a value we can load.
 *          A string value otherwise.
 */
function getDroppableData(event) {
  let links;
  try {
    links = Services.droppedLinkHandler.dropLinks(event);
  } catch (ex) {
    // This is either an unexpected failure or a security exception; in either
    // case we should always return null.
    return null;
  }
  // The URL bar automatically handles inputs with newline characters,
  // so we can get away with treating text/x-moz-url flavours as text/plain.
  if (links.length > 0 && links[0].url) {
    event.preventDefault();
    let href = links[0].url;
    if (UrlbarUtils.stripUnsafeProtocolOnPaste(href) != href) {
      // We may have stripped an unsafe protocol like javascript: and if so
      // there's no point in handling a partial drop.
      event.stopImmediatePropagation();
      return null;
    }

    try {
      // If this throws, urlSecurityCheck would also throw, as that's what it
      // does with things that don't pass the IO service's newURI constructor
      // without fixup. It's conceivable we may want to relax this check in
      // the future (so e.g. www.foo.com gets fixed up), but not right now.
      let url = new URL(href);
      // If we succeed, try to pass security checks. If this works, return the
      // URL object. If the *security checks* fail, return null.
      try {
        let principal = Services.droppedLinkHandler.getTriggeringPrincipal(event);
        BrowserUtils.urlSecurityCheck(url,
                                      principal,
                                      Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL);
        return url;
      } catch (ex) {
        return null;
      }
    } catch (ex) {
      // We couldn't make a URL out of this. Continue on, and return text below.
    }
  }
  // Handle as text.
  return event.dataTransfer.getData("text/unicode");
}

/**
 * Handles copy and cut commands for the urlbar.
 */
class CopyCutController {
  /**
   * @param {UrlbarInput} urlbar
   *   The UrlbarInput instance to use this controller for.
   */
  constructor(urlbar) {
    this.urlbar = urlbar;
  }

  /**
   * @param {string} command
   *   The name of the command to handle.
   */
  doCommand(command) {
    let urlbar = this.urlbar;
    let val = urlbar._getSelectedValueForClipboard();
    if (!val) {
      return;
    }

    if (command == "cmd_cut" && this.isCommandEnabled(command)) {
      let start = urlbar.selectionStart;
      let end = urlbar.selectionEnd;
      urlbar.inputField.value = urlbar.inputField.value.substring(0, start) +
                                urlbar.inputField.value.substring(end);
      urlbar.selectionStart = urlbar.selectionEnd = start;

      let event = urlbar.document.createEvent("UIEvents");
      event.initUIEvent("input", true, false, urlbar.window, 0);
      urlbar.inputField.dispatchEvent(event);
    }

    ClipboardHelper.copyString(val);
  }

  /**
   * @param {string} command
   * @returns {boolean}
   *   Whether the command is handled by this controller.
   */
  supportsCommand(command) {
    switch (command) {
      case "cmd_copy":
      case "cmd_cut":
        return true;
    }
    return false;
  }

  /**
   * @param {string} command
   * @returns {boolean}
   *   Whether the command should be enabled.
   */
  isCommandEnabled(command) {
    return this.supportsCommand(command) &&
           (command != "cmd_cut" || !this.urlbar.readOnly) &&
           this.urlbar.selectionStart < this.urlbar.selectionEnd;
  }

  onEvent() {}
}
