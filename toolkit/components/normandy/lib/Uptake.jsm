/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.defineModuleGetter(
  this, "UptakeTelemetry", "resource://services-common/uptake-telemetry.js");

var EXPORTED_SYMBOLS = ["Uptake"];

const COMPONENT = "normandy";

var Uptake = {
  // Action uptake
  ACTION_NETWORK_ERROR: UptakeTelemetry.STATUS.NETWORK_ERROR,
  ACTION_PRE_EXECUTION_ERROR: UptakeTelemetry.STATUS.CUSTOM_1_ERROR,
  ACTION_POST_EXECUTION_ERROR: UptakeTelemetry.STATUS.CUSTOM_2_ERROR,
  ACTION_SERVER_ERROR: UptakeTelemetry.STATUS.SERVER_ERROR,
  ACTION_SUCCESS: UptakeTelemetry.STATUS.SUCCESS,

  // Per-recipe uptake
  RECIPE_ACTION_DISABLED: UptakeTelemetry.STATUS.CUSTOM_1_ERROR,
  RECIPE_EXECUTION_ERROR: UptakeTelemetry.STATUS.APPLY_ERROR,
  RECIPE_INVALID_ACTION: UptakeTelemetry.STATUS.DOWNLOAD_ERROR,
  RECIPE_SUCCESS: UptakeTelemetry.STATUS.SUCCESS,

  // Uptake for the runner as a whole
  RUNNER_INVALID_SIGNATURE: UptakeTelemetry.STATUS.SIGNATURE_ERROR,
  RUNNER_NETWORK_ERROR: UptakeTelemetry.STATUS.NETWORK_ERROR,
  RUNNER_SERVER_ERROR: UptakeTelemetry.STATUS.SERVER_ERROR,
  RUNNER_SUCCESS: UptakeTelemetry.STATUS.SUCCESS,

  reportRunner(status) {
    UptakeTelemetry.report(COMPONENT, status, { source: `${COMPONENT}/runner` });
  },

  reportRecipe(recipeId, status) {
    UptakeTelemetry.report(COMPONENT, status, { source: `${COMPONENT}/recipe/${recipeId}` });
  },

  reportAction(actionName, status) {
    UptakeTelemetry.report(COMPONENT, status, { source: `${COMPONENT}/action/${actionName}` });
  },
};
