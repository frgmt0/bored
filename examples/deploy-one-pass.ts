/** §7.1 — the one-pass fix, run stage by stage. `npm run deploy:one-pass` */
import { deployOnePassFix } from "./scenarios.js";
import { render } from "./render.js";

render("Simulated deployment 1 · the one-pass fix", await deployOnePassFix());
