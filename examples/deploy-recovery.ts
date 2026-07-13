/** §7.3 — the failure that recovers. `npm run deploy:recovery` */
import { deployFailureThatRecovers } from "./scenarios.js";
import { render } from "./render.js";

render("Simulated deployment 3 · the failure that recovers", await deployFailureThatRecovers());
