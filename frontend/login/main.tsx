import React from "react";
import ReactDOM from "react-dom/client";
import Login from "./Login";
import { fetchHandleAuth, fetchHandleAuthLogin } from "../fetchHandleAuth";
import { ApiError, GQL_URL, hello } from "../common/gqlDeclarations";
import { logger } from "../common/logger";

const login = ReactDOM.createRoot(document.getElementById("login")!);
login.render(<Login />);

fetchHandleAuthLogin(hello.fetchCall.bind(hello, GQL_URL), undefined)
.then(() => {
    window.location.href = "/index.html";
}).catch((err) => {
    if (!(err instanceof ApiError)) {
        logger.log("Login fetch hello error not ApiError", err);
        return;
    }
    let temp = err;
    while (temp instanceof ApiError) {
        if (temp.prevError == undefined) {
            logger.log("login fetch hello error no prevError", temp.message, temp.type);
            break;
        }
        temp = temp.prevError;
    }
})


