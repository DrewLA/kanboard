import React from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

import { App } from "./ui/App.js";

const root = createRoot(document.getElementById("app-root"));
root.render(React.createElement(App));
