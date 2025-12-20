import React, { useState, useRef } from "react";
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import { fetchHandleAuthLogin, getClientId } from "../fetchHandleAuth";
import { ApiError, GQL_URL, hello, customHeaderParamClientId } from "../common/gqlDeclarations";
import { logger } from "../logger";
import { LoginDataValidator } from "../common/event_types";
import { textInput } from "../elements";
import Turnstile, { useTurnstile } from "react-turnstile";
import { cacheBuster } from "../utils";
import { GoogleOAuthProvider, GoogleLogin, useGoogleLogin } from '@react-oauth/google';
import { sleep } from "../common/utils";

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
  const [waitingGoogle, setWaitingGoogle] = useState(false);
  
  const googleToken = useRef("");
  
  // Check for error in URL query params
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      setErrorMessage(decodeURIComponent(error));
      // Clear error from URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  const [cfToken, setCfToken] = useState("");
  function TurnstileWidget() {
    return (
      <Turnstile
        sitekey="0x4AAAAAAB6_d2PuHoJS1Yze"
        onVerify={(token) => {
          setCfToken(token);
        }}
        onError={(error?: Error | any) => {
          logger.error("Turnstile error", error);
        }}
      />
    );
  }

  const login = useGoogleLogin({
      onSuccess: tokenResponse => {
        logger.log(tokenResponse)
        googleToken.current = tokenResponse.code
        handleLogin()
      },
      onError: () => 
        // setWaitingGoogle(false)
        logger.log('Google Login Failed')
      ,
      scope: "email",
      flow: 'auth-code',
      ux_mode: "redirect",
      redirect_uri: "https://bonsite.org/authggl"
    }) 
  
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
            metadata: cfToken,
            ...(googleToken.current == "" ? {} : {googleToken: googleToken.current})
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
      window.location.href = "/doc.html=" + cacheBuster();
    }).catch((err) => {
      alert("Login failed");
    }).finally(() => {
      setWaitingLogin(false);
    });
  }
  return (
    // <GoogleOAuthProvider clientId="1054579004280-r48o7o3nqk04ceaeo50ocjd4sfemh3hr.apps.googleusercontent.com">
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Create Transaction */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Sign In
        </Typography>
        {errorMessage && (
          <Typography 
            variant="body2" 
            color="error" 
            sx={{ mb: 2, p: 1, bgcolor: 'error.light', borderRadius: 1 }}
          >
            {errorMessage}
          </Typography>
        )}
        <Grid container spacing={2}>
          {[loginInput, passwordInput].map((el, idx) => <Grid item xs={12} sm={6} key={idx}>{el}</Grid>)}
          <Grid item xs={12}> 
            <Grid container direction="row" spacing={2} sx={{
                justifyContent: "flex-start",
                alignItems: "center",
              }}>
                <Grid item key={1} xs="auto">{makeButton("Sign in", 
                  // () => false
                  () => waitingGoogle || waitingLogin|| cfToken == ""
                    , 
                  handleLogin)}</Grid>
                <Grid item key={2} xs="auto">{
                        <Typography variant="body2">
                          OR
                        </Typography>
                      }
                </Grid>
                <Grid item key={3} xs="auto">{
                  <Button 
                    variant="outlined" 
                    fullWidth
                    disabled={waitingGoogle || waitingLogin || cfToken == ""}
                    onClick={() => 
                      login()
                    }
                  >
                    {waitingGoogle ? "Connecting..." : "WIP"}
                  </Button>}
                </Grid>
            </Grid>
          </Grid>
          <Grid item xs={12}>
            <Grid item key={2} xs="auto">{TurnstileWidget()}</Grid>
          </Grid>
        </Grid>
       
      </Paper>
    </Container>
  );
}
