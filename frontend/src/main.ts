import "./styles.css";
import { initFields } from "./fields.ts";
import { initNav } from "./nav.ts";
import { initSelections } from "./selection.ts";
import { initTimes } from "./time.ts";

initNav();
initTimes(document);
initFields();
initSelections();
