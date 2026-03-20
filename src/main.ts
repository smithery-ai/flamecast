import { Flamecast } from "./flamecast/index.js";

const flamecast = await Flamecast.create();
flamecast.listen(3001);
