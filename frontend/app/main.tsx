import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { fetchHandleAuth } from "../fetchHandleAuth";
import { GQL_URL, hello } from "../common/gqlDeclarations";
import { logger } from "../common/logger";


const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />)
fetchHandleAuth(hello.fetchCall.bind(hello, GQL_URL), undefined)
