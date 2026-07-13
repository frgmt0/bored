/** §7.2 — the fan-out feature (Fig 6 with data). `npm run deploy:fanout` */
import { deployFanoutFeature } from "./scenarios.js";
import { render } from "./render.js";

render("Simulated deployment 2 · the fan-out feature", await deployFanoutFeature());
