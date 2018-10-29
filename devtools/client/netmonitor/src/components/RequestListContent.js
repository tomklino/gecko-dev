/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Component, createFactory } = require("devtools/client/shared/vendor/react");
const dom = require("devtools/client/shared/vendor/react-dom-factories");
const PropTypes = require("devtools/client/shared/vendor/react-prop-types");
const { connect } = require("devtools/client/shared/redux/visibility-handler-connect");
const { HTMLTooltip } = require("devtools/client/shared/widgets/tooltip/HTMLTooltip");

const Actions = require("../actions/index");
const { formDataURI } = require("../utils/request-utils");
const {
  getDisplayedRequests,
  getSelectedRequest,
  getWaterfallScale,
} = require("../selectors/index");

loader.lazyGetter(this, "setImageTooltip", function() {
  return require("devtools/client/shared/widgets/tooltip/ImageTooltipHelper")
    .setImageTooltip;
});
loader.lazyGetter(this, "getImageDimensions", function() {
  return require("devtools/client/shared/widgets/tooltip/ImageTooltipHelper")
    .getImageDimensions;
});

// Components
const RequestListHeader = createFactory(require("./RequestListHeader"));
const RequestListItem = createFactory(require("./RequestListItem"));
const RequestListContextMenu = require("../widgets/RequestListContextMenu");

const { div } = dom;

// Tooltip show / hide delay in ms
const REQUESTS_TOOLTIP_TOGGLE_DELAY = 500;
// Tooltip image maximum dimension in px
const REQUESTS_TOOLTIP_IMAGE_MAX_DIM = 400;
// Gecko's scrollTop is int32_t, so the maximum value is 2^31 - 1 = 2147483647
const MAX_SCROLL_HEIGHT = 2147483647;

const LEFT_MOUSE_BUTTON = 0;
const RIGHT_MOUSE_BUTTON = 2;

/**
 * Renders the actual contents of the request list.
 */
class RequestListContent extends Component {
  static get propTypes() {
    return {
      connector: PropTypes.object.isRequired,
      columns: PropTypes.object.isRequired,
      networkDetailsOpen: PropTypes.bool.isRequired,
      networkDetailsWidth: PropTypes.number,
      networkDetailsHeight: PropTypes.number,
      cloneRequest: PropTypes.func.isRequired,
      openDetailsPanelTab: PropTypes.func.isRequired,
      displayedRequests: PropTypes.array.isRequired,
      clickedRequest: PropTypes.object,
      firstRequestStartedMillis: PropTypes.number.isRequired,
      fromCache: PropTypes.bool,
      onCauseBadgeMouseDown: PropTypes.func.isRequired,
      onItemMouseDown: PropTypes.func.isRequired,
      selectRequest: PropTypes.func.isRequired,
      onItemRightMouseButtonDown: PropTypes.func.isRequired,
      onSecurityIconMouseDown: PropTypes.func.isRequired,
      onSelectDelta: PropTypes.func.isRequired,
      onWaterfallMouseDown: PropTypes.func.isRequired,
      openStatistics: PropTypes.func.isRequired,
      scale: PropTypes.number,
      selectedRequest: PropTypes.object,
      requestFilterTypes: PropTypes.object.isRequired,
    };
  }

  constructor(props) {
    super(props);
    this.isScrolledToBottom = this.isScrolledToBottom.bind(this);
    this.onHover = this.onHover.bind(this);
    this.onScroll = this.onScroll.bind(this);
    this.onResize = this.onResize.bind(this);
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onContextMenu = this.onContextMenu.bind(this);
    this.onFocusedNodeChange = this.onFocusedNodeChange.bind(this);
    this.onMouseDown = this.onMouseDown.bind(this);
  }

  componentWillMount() {
    this.tooltip = new HTMLTooltip(window.parent.document, { type: "arrow" });
    window.addEventListener("resize", this.onResize);
  }

  componentDidMount() {
    // Install event handler for displaying a tooltip
    this.tooltip.startTogglingOnHover(this.refs.contentEl, this.onHover, {
      toggleDelay: REQUESTS_TOOLTIP_TOGGLE_DELAY,
      interactive: true
    });
    // Install event handler to hide the tooltip on scroll
    this.refs.contentEl.addEventListener("scroll", this.onScroll, true);
    this.onResize();
  }

  componentWillUpdate(nextProps) {
    // Check if the list is scrolled to bottom before the UI update.
    // The scroll is ever needed only if new rows are added to the list.
    const delta = nextProps.displayedRequests.size - this.props.displayedRequests.size;
    this.shouldScrollBottom = delta > 0 && this.isScrolledToBottom();
  }

  componentDidUpdate(prevProps) {
    const node = this.refs.contentEl;
    // Keep the list scrolled to bottom if a new row was added
    if (this.shouldScrollBottom && node.scrollTop !== MAX_SCROLL_HEIGHT) {
      // Using maximum scroll height rather than node.scrollHeight to avoid sync reflow.
      node.scrollTop = MAX_SCROLL_HEIGHT;
    }
    if (prevProps.networkDetailsOpen !== this.props.networkDetailsOpen ||
      prevProps.networkDetailsWidth !== this.props.networkDetailsWidth ||
      prevProps.networkDetailsHeight !== this.props.networkDetailsHeight
    ) {
      this.onResize();
    }
  }

  componentWillUnmount() {
    this.refs.contentEl.removeEventListener("scroll", this.onScroll, true);

    // Uninstall the tooltip event handler
    this.tooltip.stopTogglingOnHover();
    window.removeEventListener("resize", this.onResize);
  }

  onResize() {
    const parent = this.refs.contentEl.parentNode;
    this.refs.contentEl.style.width = parent.offsetWidth + "px";
    this.refs.contentEl.style.height = parent.offsetHeight + "px";
  }

  isScrolledToBottom() {
    const { contentEl } = this.refs;
    const lastChildEl = contentEl.lastElementChild;

    if (!lastChildEl) {
      return false;
    }

    const lastChildRect = lastChildEl.getBoundingClientRect();
    const contentRect = contentEl.getBoundingClientRect();

    return (lastChildRect.height + lastChildRect.top) <= contentRect.bottom;
  }

  /**
   * The predicate used when deciding whether a popup should be shown
   * over a request item or not.
   *
   * @param Node target
   *        The element node currently being hovered.
   * @param object tooltip
   *        The current tooltip instance.
   * @return {Promise}
   */
  async onHover(target, tooltip) {
    const itemEl = target.closest(".request-list-item");
    if (!itemEl) {
      return false;
    }
    const itemId = itemEl.dataset.id;
    if (!itemId) {
      return false;
    }
    const requestItem = this.props.displayedRequests.find(r => r.id == itemId);
    if (!requestItem) {
      return false;
    }

    if (!target.closest(".requests-list-file")) {
      return false;
    }

    const { mimeType } = requestItem;
    if (!mimeType || !mimeType.includes("image/")) {
      return false;
    }

    const responseContent = await this.props.connector
      .requestData(requestItem.id, "responseContent");
    const { encoding, text } = responseContent.content;
    const src = formDataURI(mimeType, encoding, text);
    const maxDim = REQUESTS_TOOLTIP_IMAGE_MAX_DIM;
    const { naturalWidth, naturalHeight } = await getImageDimensions(tooltip.doc, src);
    const options = { maxDim, naturalWidth, naturalHeight };
    setImageTooltip(tooltip, tooltip.doc, src, options);

    return itemEl.querySelector(".requests-list-file");
  }

  /**
   * Scroll listener for the requests menu view.
   */
  onScroll() {
    this.tooltip.hide();
  }

  onMouseDown(e, id) {
    if (e.button === LEFT_MOUSE_BUTTON) {
      this.props.selectRequest(id)
    } else if(e.button === RIGHT_MOUSE_BUTTON) {
      this.props.onItemRightMouseButtonDown(id)
    }
  }

  /**
   * Handler for keyboard events. For arrow up/down, page up/down, home/end,
   * move the selection up or down.
   */
  onKeyDown(evt) {
    let delta;

    switch (evt.key) {
      case "ArrowUp":
      case "ArrowLeft":
        delta = -1;
        break;
      case "ArrowDown":
      case "ArrowRight":
        delta = +1;
        break;
      case "PageUp":
        delta = "PAGE_UP";
        break;
      case "PageDown":
        delta = "PAGE_DOWN";
        break;
      case "Home":
        delta = -Infinity;
        break;
      case "End":
        delta = +Infinity;
        break;
    }

    if (delta) {
      // Prevent scrolling when pressing navigation keys.
      evt.preventDefault();
      evt.stopPropagation();
      this.props.onSelectDelta(delta);
    }
  }

  onContextMenu(evt) {
    evt.preventDefault();
    const { displayedRequests, clickedRequest } = this.props;
    console.log("RequestListContent: onContextMenu: clickedRequest", clickedRequest)
    if (!this.contextMenu) {
      const {
        connector,
        cloneRequest,
        openDetailsPanelTab,
        openStatistics,
      } = this.props;
      this.contextMenu = new RequestListContextMenu({
        connector,
        cloneRequest,
        openDetailsPanelTab,
        openStatistics,
      });
    }

    this.contextMenu.open(evt, clickedRequest, displayedRequests);
  }

  /**
   * If selection has just changed (by keyboard navigation), don't keep the list
   * scrolled to bottom, but allow scrolling up with the selection.
   */
  onFocusedNodeChange() {
    this.shouldScrollBottom = false;
  }

  render() {
    const {
      connector,
      columns,
      displayedRequests,
      firstRequestStartedMillis,
      onCauseBadgeMouseDown,
      onItemMouseDown,
      selectRequest,
      onItemRightMouseButtonDown,
      onSecurityIconMouseDown,
      onWaterfallMouseDown,
      requestFilterTypes,
      scale,
      selectedRequest,
    } = this.props;

    return (
      div({ className: "requests-list-wrapper" },
        div({ className: "requests-list-table" },
          div({
            ref: "contentEl",
            className: "requests-list-contents",
            tabIndex: 0,
            onKeyDown: this.onKeyDown,
            style: { "--timings-scale": scale, "--timings-rev-scale": 1 / scale }
          },
            RequestListHeader(),
            displayedRequests.map((item, index) => RequestListItem({
              firstRequestStartedMillis,
              fromCache: item.status === "304" || item.fromCache,
              connector,
              columns,
              item,
              index,
              isSelected: item.id === (selectedRequest && selectedRequest.id),
              key: item.id,
              onContextMenu: (evt) => { this.onContextMenu(evt) },
              onFocusedNodeChange: this.onFocusedNodeChange,
              onMouseDown: (e) => this.onMouseDown(e, item.id),
              onCauseBadgeMouseDown: () => onCauseBadgeMouseDown(item.cause),
              onSecurityIconMouseDown: () => onSecurityIconMouseDown(item.securityState),
              onWaterfallMouseDown: () => onWaterfallMouseDown(),
              requestFilterTypes,
            }))
          )
        )
      )
    );
  }
}

module.exports = connect(
  (state) => ({
    columns: state.ui.columns,
    networkDetailsOpen: state.ui.networkDetailsOpen,
    networkDetailsWidth: state.ui.networkDetailsWidth,
    networkDetailsHeight: state.ui.networkDetailsHeight,
    displayedRequests: getDisplayedRequests(state),
    clickedRequest: state.requests.clickedRequest,
    firstRequestStartedMillis: state.requests.firstStartedMillis,
    selectedRequest: getSelectedRequest(state),
    scale: getWaterfallScale(state),
    requestFilterTypes: state.filters.requestFilterTypes,
  }),
  (dispatch, props) => ({
    cloneRequest: (id) => {
      dispatch(Actions.cloneRequest(id));
    },
    openDetailsPanelTab: () => {
      dispatch(Actions.openNetworkDetails(true));
    },
    openStatistics: (open) => dispatch(Actions.openStatistics(props.connector, open)),
    /**
     * A handler that opens the stack trace tab when a stack trace is available
     */
    onCauseBadgeMouseDown: (cause) => {
      if (cause.stacktrace && cause.stacktrace.length > 0) {
        dispatch(Actions.selectDetailsPanelTab("stack-trace"));
      }
    },
    selectRequest: (id) => {
      dispatch(Actions.selectRequest(id))
    },

    onItemRightMouseButtonDown: (id) => {
      dispatch(Actions.rightClickRequest(id))
    },

    onItemMouseDown: (id) => {
      dispatch(Actions.selectRequest(id))
    },

    /**
     * A handler that opens the security tab in the details view if secure or
     * broken security indicator is clicked.
     */
    onSecurityIconMouseDown: (securityState) => {
      if (securityState && securityState !== "insecure") {
        dispatch(Actions.selectDetailsPanelTab("security"));
      }
    },
    onSelectDelta: (delta) => dispatch(Actions.selectDelta(delta)),
    /**
     * A handler that opens the timing sidebar panel if the waterfall is clicked.
     */
    onWaterfallMouseDown: () => {
      dispatch(Actions.selectDetailsPanelTab("timings"));
    },
  }),
)(RequestListContent);
