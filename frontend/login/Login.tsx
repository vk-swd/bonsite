import React, { useState, useRef } from "react";
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import { fetchHandleAuthLogin } from "../fetchHandleAuth";
import { ApiError, GQL_URL, hello, customHeaderParamClientId } from "../common/gqlDeclarations";
import { logger } from "../common/logger";
import { LoginDataValidator } from "../common/event_types";
import { textInput } from "../elements";
import Turnstile, { useTurnstile } from "react-turnstile";


function makeButton<T>(lab: string | (() => string), toggler: () => boolean, onClick: () => void) {
  return <Button variant="contained"
    disabled={toggler()}
    onClick={onClick}>
    {lab instanceof Function ? lab() : lab}
  </Button>
}
function label(toggler: () => string) {
  return <Typography>
    {toggler()}
  </Typography>
}
//check authentication by calling hello
fetchHandleAuthLogin(hello.fetchCall.bind(hello, GQL_URL), undefined)
.then(() => {
    window.location.href = "/doc.html";
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
function TurnstileWidget(tokenRef: React.MutableRefObject<string>) {
  const turnstile = useTurnstile();
  return (
    <Turnstile
      sitekey="0x4AAAAAAB6_d2PuHoJS1Yze"
      onVerify={(token) => {
        tokenRef.current = token;
      }}
      onError={(error?: Error | any) => {
        logger.error("Turnstile error", error);
      }}
    />
  );
}
export default function Login() {
  const loginInput = textInput<string>("Login", useState(""));
  const passwordInput = textInput<string>("Password", useState(""));
  const [waitingLogin, setWaitingLogin] = useState(false);
  const cfToken = useRef("");
  async function handleLogin() {
    setWaitingLogin(true);
      fetchHandleAuthLogin((clientId: string) => {
        return fetch("/login", {
          method: "POST", 
          headers: {
            "Content-Type": "application/json", 
            Accept: "application/json" ,
            [customHeaderParamClientId]: clientId
          },
          body: JSON.stringify(LoginDataValidator.parse({ 
            user: (loginInput.props as any).value, 
            password: (passwordInput.props as any).value,
            metadata: cfToken.current
          }))
      }).then(res => {
        if (!res.ok) {
          return res.json().then(data => {
            throw data
          })
        }
        return res;
      })
    }).then((resp) => {
      window.location.href = "/doc.html";
    }).catch((err) => {
      alert("Login failed");
    }).finally(() => {
      setWaitingLogin(false);
    });
  }
  
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Create Transaction */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Sign In
        </Typography>
      </Paper>
    </Container>
  );
}
