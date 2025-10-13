import React, { useRef, useState, Dispatch, SetStateAction } from "react";
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import { fetchHandleAuth, fetchHandleAuthLogin } from "../fetchHandleAuth";
import { ApiError, ApiErrorType, customHeaderParamClientId } from "../common/gqlDeclarations";
import { logger } from "../common/logger";
import { LoginDataValidator } from "../common/event_types";
import { textInput } from "../elements";



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

export default function Login() {
  const loginInput = textInput<string>("Login", useState(""));
  const passwordInput = textInput<string>("Password", useState(""));
  const [waitingLogin, setWaitingLogin] = useState(false);
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
          password: (passwordInput.props as any).value }))
      }).then(res => {
        if (!res.ok) {
          return res.json().then(data => {
            throw data
          })
        }
        return res;
      })
    }).then((resp) => {
      window.location.href = "/index.html";
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
          <Grid item xs={12}>
            {makeButton("Sign in", () => waitingLogin, handleLogin)}
          </Grid>
        </Grid>
      </Paper>
    </Container>
  );
}
