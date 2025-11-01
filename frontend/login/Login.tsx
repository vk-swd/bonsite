import React, { useState, useRef } from "react";
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import { fetchHandleAuthLogin } from "../fetchHandleAuth";
import { ApiError, GQL_URL, hello, customHeaderParamClientId } from "../common/gqlDeclarations";
import { logger } from "../logger";
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

function TurnstileWidget(tokenRef: React.MutableRefObject<string>) {
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
        logger.info('trying to login')
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
        <Grid container spacing={2}>
          {[loginInput,
            passwordInput].map((el, idx) =>
              <Grid item xs={12} sm={6} key={idx}>{el}</Grid>)}
              <Grid item> 
                <Grid container direction="row" spacing={2} sx={{
                    justifyContent: "flex-start",
                    alignItems: "flex-start",
                  }}>
                    <Grid item key={1} xs="auto">{makeButton("Sign in", () => waitingLogin, handleLogin)}</Grid>
                    <Grid item key={2} xs="auto">{TurnstileWidget(cfToken)}</Grid>
                </Grid>
            </Grid>
        </Grid>
       
      </Paper>
    </Container>
  );
}
