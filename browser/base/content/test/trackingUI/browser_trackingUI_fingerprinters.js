/* eslint-disable mozilla/no-arbitrary-setTimeout */
/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TRACKING_PAGE = "http://example.org/browser/browser/base/content/test/trackingUI/trackingPage.html";
const FP_PREF = "privacy.trackingprotection.fingerprinting.enabled";

add_task(async function setup() {
  await SpecialPowers.pushPrefEnv({set: [
    [ ContentBlocking.prefIntroCount, ContentBlocking.MAX_INTROS ],
    [ "urlclassifier.features.fingerprinting.blacklistHosts", "fingerprinting.example.com" ],
    [ "privacy.trackingprotection.enabled", false ],
    [ "privacy.trackingprotection.annotate_channels", false ],
    [ "privacy.trackingprotection.cryptomining.enabled", false ],
  ]});
});

async function testIdentityState(hasException) {
  let promise = BrowserTestUtils.openNewForegroundTab({url: TRACKING_PAGE, gBrowser});
  let [tab] = await Promise.all([promise, waitForContentBlockingEvent()]);

  ok(!ContentBlocking.content.hasAttribute("detected"), "fingerprinters are not detected");
  ok(BrowserTestUtils.is_hidden(ContentBlocking.iconBox), "icon box is not visible");

  promise = waitForContentBlockingEvent();

  await ContentTask.spawn(tab.linkedBrowser, {}, function() {
    content.postMessage("fingerprinting", "*");
  });

  await promise;

  ok(ContentBlocking.content.hasAttribute("detected"), "trackers are detected");
  ok(BrowserTestUtils.is_visible(ContentBlocking.iconBox), "icon box is visible");
  is(ContentBlocking.iconBox.hasAttribute("hasException"), hasException,
    "Shows an exception when appropriate");

  BrowserTestUtils.removeTab(tab);
}

async function testSubview(hasException) {
  let promise = BrowserTestUtils.openNewForegroundTab({url: TRACKING_PAGE, gBrowser});
  let [tab] = await Promise.all([promise, waitForContentBlockingEvent()]);

  promise = waitForContentBlockingEvent();
  await ContentTask.spawn(tab.linkedBrowser, {}, function() {
    content.postMessage("fingerprinting", "*");
  });
  await promise;

  await openIdentityPopup();

  let categoryItem =
    document.getElementById("identity-popup-content-blocking-category-fingerprinters");
  ok(BrowserTestUtils.is_visible(categoryItem), "TP category item is visible");
  let subview = document.getElementById("identity-popup-fingerprintersView");
  let viewShown = BrowserTestUtils.waitForEvent(subview, "ViewShown");
  categoryItem.click();
  await viewShown;

  let listItems = subview.querySelectorAll(".identity-popup-content-blocking-list-item");
  is(listItems.length, 1, "We have 1 item in the list");
  let listItem = listItems[0];
  ok(BrowserTestUtils.is_visible(listItem), "List item is visible");
  is(listItem.querySelector("label").value, "fingerprinting.example.com", "Has the correct host");
  is(listItem.classList.contains("allowed"), hasException,
    "Indicates the fingerprinter was blocked or allowed");

  let mainView = document.getElementById("identity-popup-mainView");
  viewShown = BrowserTestUtils.waitForEvent(mainView, "ViewShown");
  let backButton = subview.querySelector(".subviewbutton-back");
  backButton.click();
  await viewShown;

  ok(true, "Main view was shown");

  BrowserTestUtils.removeTab(tab);
}

add_task(async function test() {
  let uri = Services.io.newURI("https://example.org");

  Services.prefs.setBoolPref(FP_PREF, true);

  await testIdentityState(false);
  Services.perms.add(uri, "trackingprotection", Services.perms.ALLOW_ACTION);
  // TODO: This currently fails because of bug 1525458, fixing should allow us to re-enable it.
  // await testIdentityState(true);
  Services.perms.remove(uri, "trackingprotection");

  await testSubview(false);
  Services.perms.add(uri, "trackingprotection", Services.perms.ALLOW_ACTION);
  // TODO: This currently fails because of bug 1525458, fixing should allow us to re-enable it.
  // await testSubview(true);
  Services.perms.remove(uri, "trackingprotection");

  Services.prefs.clearUserPref(FP_PREF);
});

