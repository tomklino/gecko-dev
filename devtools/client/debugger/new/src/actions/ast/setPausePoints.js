/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at <http://mozilla.org/MPL/2.0/>. */

// @flow

import { getSourceFromId } from "../../selectors";
import * as parser from "../../workers/parser";
import { convertToList } from "../../utils/pause/pausePoints";
import { features } from "../../utils/prefs";
import { getGeneratedLocation } from "../../utils/source-maps";

import type { SourceId } from "../../types";
import type { ThunkArgs, Action } from "../types";

async function mapLocations(pausePoints, state, source, sourceMaps) {
  const pausePointList = convertToList(pausePoints);
  const sourceId = source.id;

  return Promise.all(
    pausePointList.map(async ({ types, location }) => {
      const generatedLocation = await getGeneratedLocation(
        state,
        source,
        {
          ...location,
          sourceId
        },
        sourceMaps
      );

      return { types, location, generatedLocation };
    })
  );
}
export function setPausePoints(sourceId: SourceId) {
  return async ({ dispatch, getState, client, sourceMaps }: ThunkArgs) => {
    const source = getSourceFromId(getState(), sourceId);
    if (!features.pausePoints || !source || !source.text) {
      return;
    }

    if (source.isWasm) {
      return;
    }

    const pausePoints = await mapLocations(
      await parser.getPausePoints(sourceId),
      getState(),
      source,
      sourceMaps
    );

    dispatch(
      ({
        type: "SET_PAUSE_POINTS",
        sourceText: source.text || "",
        sourceId,
        pausePoints
      }: Action)
    );
  };
}
