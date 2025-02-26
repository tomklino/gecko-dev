/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/* Patch directory path traversal failure test */

const STATE_AFTER_RUNUPDATE =
  IS_SERVICE_TEST ? STATE_PENDING_SVC : STATE_PENDING;

function run_test() {
  if (!setupTestCommon()) {
    return;
  }
  gTestFiles = gTestFilesCompleteSuccess;
  gTestDirs = gTestDirsCompleteSuccess;
  setTestFilesAndDirsForFailure();
  setupUpdaterTest(FILE_COMPLETE_MAR, false);
}

/**
 * Called after the call to setupUpdaterTest finishes.
 */
function setupUpdaterTestFinished() {
  let path = getUpdateDirFile(DIR_PATCH);
  if (AppConstants.platform == "win") {
    path = path + "\\..\\";
  } else {
    path = path + "/../";
  }

  runUpdate(STATE_AFTER_RUNUPDATE, false, 1, true, path, null, null, null);
}

/**
 * Called after the call to runUpdateUsingUpdater finishes.
 */
function runUpdateFinished() {
  standardInit();
  checkPostUpdateRunningFile(false);
  checkFilesAfterUpdateFailure(getApplyDirFile);
  executeSoon(waitForUpdateXMLFiles);
}

/**
 * Called after the call to waitForUpdateXMLFiles finishes.
 */
function waitForUpdateXMLFilesFinished() {
  checkUpdateManager(STATE_NONE, false, STATE_AFTER_RUNUPDATE, 0, 1);
  waitForFilesInUse();
}
