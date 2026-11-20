import "./styles.css";
import { initDesign } from "./design/design-site.ts";
import { initEditor } from "./editor-site.ts";
import { initFields } from "./fields.ts";
import { initFolders } from "./folders.ts";
import { initNav } from "./nav.ts";
import { initSelections } from "./selection.ts";
import { initTimes } from "./time.ts";

initNav();
initTimes(document);
initFields();
initFolders();
initSelections();
initEditor();
initDesign();
