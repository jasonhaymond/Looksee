// The code the app shares with the web dashboard: the typed API client (one
// function per engine route) and the check-type registry (every check type's
// label, category and settings fields). Imported from the dashboard's own
// files, so a new engine route or check type reaches the app with no copy to
// keep in step. metro.config.js lets the bundler read that folder.
//
// Everything else in the app imports these through this file, so the long
// relative path lives in one place.

export * from "../../../dashboard/app/lib/api";
export * from "../../../dashboard/app/lib/checkTypes";
// Safe property lookups by a key that comes from data (never __proto__ etc.).
export { own, setOwn } from "../../../dashboard/app/lib/own";
