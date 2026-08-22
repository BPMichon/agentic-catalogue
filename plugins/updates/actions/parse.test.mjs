/**
 * The one check worth leaving behind: the table parser.
 *
 *   node --experimental-strip-types --test parse.test.mjs
 *
 * Captured output rather than a live `winget upgrade`, because the cases that
 * break a parser — a second table, an empty Source, a name with spaces — are the
 * ones this machine happens not to have on any given day.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseUpgrades } from "./index.ts";

// Real winget layout: fixed-width columns, a dash rule, a summary line, then the
// second table for packages that cannot be upgraded in bulk.
const SAMPLE = [
	"Name                 Id                       Version        Available      Source",
	"------------------------------------------------------------------------------------",
	"1Password CLI        AgileBits.1Password.CLI  2.34.1         2.35.0         winget",
	"Windows Terminal     Microsoft.WindowsTerm…   1.21.2701.0    1.22.3232.0    msstore",
	"Cirrus Audio Driver  ARP\\Machine\\X86\\{9ff}    6.2.41         6.3.0          ",
	"",
	"3 upgrades available.",
	"",
	"The following packages have an upgrade available, but require explicit targeting for upgrade:",
	"Name        Id                Version   Available   Source",
	"-----------------------------------------------------------",
	"Old Thing   Vendor.OldThing   Unknown   1.4.0       winget",
	"",
].join("\r\n");

test("reads every row of both tables", () => {
	const rows = parseUpgrades(SAMPLE);
	assert.equal(rows.length, 4);
});

test("keeps a name containing spaces intact", () => {
	const [first] = parseUpgrades(SAMPLE);
	assert.deepEqual(first, {
		name: "1Password CLI",
		id: "AgileBits.1Password.CLI",
		version: "2.34.1",
		available: "2.35.0",
		source: "winget",
		explicit: false,
	});
});

test("an empty trailing Source column reads as empty, not as a shifted row", () => {
	const driver = parseUpgrades(SAMPLE).find((row) => row.name === "Cirrus Audio Driver");
	assert.equal(driver.source, "");
	assert.equal(driver.available, "6.3.0");
});

test("distinguishes Store-sourced packages", () => {
	assert.equal(parseUpgrades(SAMPLE).filter((row) => row.source === "msstore").length, 1);
});

test("flags the second table as needing explicit targeting", () => {
	const rows = parseUpgrades(SAMPLE);
	assert.deepEqual(
		rows.filter((row) => row.explicit).map((row) => row.id),
		["Vendor.OldThing"],
	);
});

test("nothing to upgrade parses to nothing, not to a bogus row", () => {
	assert.deepEqual(parseUpgrades("No installed package found matching input criteria.\r\n"), []);
});

test("progress redraws before the table do not become rows", () => {
	const noisy = `  -\r  \\\r  |\r${SAMPLE}`;
	assert.equal(parseUpgrades(noisy).length, 4);
});
