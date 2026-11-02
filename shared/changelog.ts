// What each Tandem release changed, newest first. The site shows it before it
// commits a release to anyone's repo, and at tandemkb.com/changelog. The newest
// entry's version must match template/tandem/zmk-tandem/version.txt.

export interface Release {
  version: number;
  date: string;
  title: string;
  changes: string[];
}

export const CHANGELOG: Release[] = [
  {
    version: 4,
    date: "2026-11-01",
    title: "Tested versions, and a way back",
    changes: [
      "Builds use the exact ZMK, Zephyr and build image Tandem tested. Before, they used whatever Kinesis's branches pointed to that day, so one commit could build different firmware a week later.",
      "Both halves report which Tandem release they run.",
      "Kinesis's changes to its config reach your repo with a keyboard update, once Tandem has tested them. Your layout stays as it is.",
      "You can put an older build back on the keyboard, undo an update Tandem committed, or go back to Kinesis's firmware.",
    ],
  },
  {
    version: 3,
    date: "2026-10-29",
    title: "Every paired computer reconnects",
    changes: [
      "A computer on another Bluetooth profile can reconnect after it drops. ZMK only lets the active profile's computer back in, so the other one stayed locked out until you switched to it.",
      "For the first 30 seconds the left half advertises as fast as ZMK does. After that it advertises about once a second, which uses less battery while a computer stays away.",
    ],
  },
  {
    version: 2,
    date: "2026-10-28",
    title: "Faster builds",
    changes: ["Builds fetch only the modules the firmware uses, so a repo's first build spends 13 seconds fetching them instead of 140."],
  },
  {
    version: 1,
    date: "2026-10-23",
    title: "Updates with no key presses",
    changes: [
      "Each half restarts into update mode when Tandem asks, and the left half restarts the right one over the split link.",
      "Keys can repeat when you tap them and then hold, with the &ltr and &mtr behaviors.",
    ],
  },
];

/** The releases a repo on `from` doesn't have. Before releases had numbers, that could be any of them. */
export function releasesSince(from: number | null): Release[] {
  return CHANGELOG.filter((r) => from === null || r.version > from);
}
