// tandemkb.com/changelog. Every Tandem release, from shared/changelog.ts.

import { CHANGELOG } from "../shared/changelog";
import pins from "../shared/pins.json";
import { DocHead } from "./components/DocHead";

const day = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" });

export function Changelog() {
  return (
    <div className="doc">
      <DocHead />

      <main className="doc__body">
        <h1>Changelog</h1>
        <p className="lede">
          A release is what Tandem commits to your repo: the firmware module, its changes to your build, and the versions of Kinesis's config and ZMK it
          was tested with.
        </p>

        {CHANGELOG.map((release) => (
          <section key={release.version}>
            <h2>
              Tandem {release.version}: {release.title}
            </h2>
            <p className="doc__date">{day.format(new Date(release.date))}</p>
            <ul>
              {release.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </section>
        ))}

        <h2>What the latest release builds from</h2>
        <ul>
          <li>
            Kinesis's config: <code>{pins.kinesis.repo}</code> at <code>{pins.kinesis.sha.slice(0, 7)}</code>
          </li>
          <li>
            ZMK: <code>{pins.zmk.repo}</code> at <code>{pins.zmk.sha.slice(0, 7)}</code>
          </li>
          <li>
            Zephyr: <code>{pins.zephyr.repo}</code> at <code>{pins.zephyr.sha.slice(0, 7)}</code>
          </li>
        </ul>

        <p className="doc__foot">
          The source is at{" "}
          <a href="https://github.com/itsthecsguy/tandem" target="_blank" rel="noreferrer">
            github.com/itsthecsguy/tandem
          </a>
          .
        </p>
      </main>
    </div>
  );
}
