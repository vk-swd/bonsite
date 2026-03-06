import React from "react";
import ReactDOM from "react-dom/client";
import Login from "./Login";

const login = ReactDOM.createRoot(document.getElementById("login")!);
// 1054579004280-r48o7o3nqk04ceaeo50ocjd4sfemh3hr.apps.googleusercontent.com
// 1078992815106-brpsupgvhheqg35tupphbh0qk9c32nq8.apps.googleusercontent.com
// login.render(<GoogleOAuthProvider clientId="1078992815106-brpsupgvhheqg35tupphbh0qk9c32nq8.apps.googleusercontent.com">
login.render(<Login />);
