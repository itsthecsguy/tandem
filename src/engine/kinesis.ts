// Kinesis's physical layout, bundled from the config template, for drawing the
// keyboard before any repo is connected.

import { readLayout } from "../../shared/layout";
import infoJson from "../../config/info.json?raw";

export const KINESIS_LAYOUT = readLayout(infoJson);
