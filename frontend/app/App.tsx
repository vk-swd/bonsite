import React, { useRef, useState, Dispatch, SetStateAction } from "react";
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';

import { GenerationState, GenParametersValidator, ProgressReport } from "../common/generator_parameters.js";
import * as gqlp from "../common/gqlDeclarations.js"
import { logger } from "../common/logger.js";
import { StatementParametersValidator, StatementRequestResult, StatementType, Transaction, UserDataRequestParameters, UserDataResult } from "../common/event_types.js";
import { getUserSelectItem } from "./MenuList.js";
import { StatementChild, StatementContainer } from "./StatementList.js";
import { fetchHandleAuth } from "../fetchHandleAuth.js";
import { textInput } from "../elements.js";
type UserOption = {
  value: string;
  label: string;
  id: number;
  cursor: number;
};
enum StartGenButtonStates {
  Generating,
  NotGenerating
}
const startGenButtonStates = new Map<StartGenButtonStates, { buttonLabel: string, buttonDisabled: boolean }>([
  [StartGenButtonStates.NotGenerating, { buttonLabel: "Start Generation", buttonDisabled: false }],
  [StartGenButtonStates.Generating, { buttonLabel: "Stop Generation", buttonDisabled: false }]])


function dateTimeInput<T>(lab: string, state: [string, Dispatch<SetStateAction<string>>], min?: string, max?: string): JSX.Element {
  return <TextField
    fullWidth
    label={lab}
    type="datetime-local"
    InputLabelProps={{ shrink: true }}
    inputProps={{
      step: 1
      , // allows seconds,
      min, max
    }}
    value={state[0]}
    onChange={(e) => state[1](e.target.value)}
  />
}


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
function localTimeStringFromUtcMS(utcMs: number) {
  const d = new Date(utcMs);
  return new Date(utcMs - d.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}
export default function App() {

  //------ Post Transaction----------------
  const postTranactionDate = dateTimeInput("Date", useState(new Date(2025, 1, 1, 0, 0, 0).toISOString().slice(0, -1)));
  const postTransactionUserIdFrom = textInput<number>("User Id From", useState(1));
  const postTransactionUserIdTo = textInput<number>("User Id To", useState(2));
  const postTransactionAmount = textInput<number>("Amount", useState(100));

  const postedStas = useRef({ success: 0, failed: 0 });
  const [postButtonState, setPostButtonState] = useState(false);
  const [postedStasTxt, renderPostedStatsTxt] = useState("");
  const [startGenTxt, setStartGenTxt] = useState("");
  const updatePostedStatsTxt = () => {
    if (postedStas.current.success === 0 && postedStas.current.failed === 0) {
      renderPostedStatsTxt("");
      return;
    }
    let txt = `Posted: ${postedStas.current.success}`;
    if (postedStas.current.failed > 0) {
      txt += `, Failed: ${postedStas.current.failed}`;
    }
    renderPostedStatsTxt(txt);
  }
  function postTransaction() {
    setPostButtonState(true);
    const params = {
      date: new Date(postTranactionDate.props.value).getTime(),
      userFrom: postTransactionUserIdFrom.props.value,
      userTo: postTransactionUserIdTo.props.value,
      amount: postTransactionAmount.props.value
    };
    logger.info(`Posting transaction with params:`, postTransactionUserIdFrom.props.value, postTransactionUserIdTo.props.value);
    fetchHandleAuth(gqlp.postTransaction.fetchCall.bind(gqlp.postTransaction, gqlp.GQL_URL), 
                    gqlp.postTransaction.coercedParamType!.parse(params))
    .then(_ => {
      postedStas.current.success++;
      updatePostedStatsTxt();
    }).catch(err => {
      postedStas.current.failed++;
      renderPostedStatsTxt(err.message);
    }).finally(() => {
      setPostButtonState(false);
    });
  }

  //------ Generate Transactions----------------
  const now = new Date();
  const before = new Date();
  before.setFullYear(before.getFullYear() - 25);
  const [genTransactionDateFrom, setGenTransactionDateFrom] = useState(() => localTimeStringFromUtcMS(new Date().setFullYear(new Date().getFullYear() - 25)));
  const [genTransactionDateTo, setGenTransactionDateTo] = useState(() => localTimeStringFromUtcMS(new Date().getTime()));
  const genTransactionDateFromElement = dateTimeInput("From", [genTransactionDateFrom, setGenTransactionDateFrom], undefined, genTransactionDateTo);
  const genTransactionDateToElement = dateTimeInput("To", [genTransactionDateTo, setGenTransactionDateTo], genTransactionDateFrom);
  const genTransactionUserCount = textInput<number>("User Count", useState(10000));
  const genTransactionTransactionCount = textInput<number>("Transactions Count", useState(1000000));
  const [minUserId, setMinUserId] = useState<number>(1);
  const [minTransactionId, setMinTransactionId] = useState<number>(1);
  const genTransactionMinUserId = textInput<number>("Min User Id", [minUserId, setMinUserId]);
  const genTransactionMinTransactionId = textInput<number>("Min Transaction Id", [minTransactionId, setMinTransactionId]);
  const genTransactionMaxDelayMs = textInput<number>("Transaction Result Delay Ms.", useState(100));
  const [startGenButtonState, setStartGenButtonState] = useState(StartGenButtonStates.NotGenerating);
  // TODO: output generation task id.
  const recoverGenButtonState = useRef<boolean>(false);
  async function recoverGenButton() {
    if (recoverGenButtonState.current) {
      return;
    }
    recoverGenButtonState.current = true;
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const lastProgressReport = await fetchHandleAuth(gqlp.getProgress.fetchCall.bind(gqlp.getProgress, gqlp.GQL_URL), undefined);
      if (lastProgressReport.isRunning === GenerationState.RUNNING) {
        setStartGenTxt(`Progress: Sent: ${lastProgressReport.totalSent}, ${lastProgressReport.percentComplete}%`);
      } else {
        setStartGenTxt(`Finished. Sent: ${lastProgressReport.totalSent}.`);
        break;
      }
    }
    recoverGenButtonState.current = false;
    setStartGenButtonState(StartGenButtonStates.NotGenerating)
  }
  async function startGeneration() {
    try {
      if (startGenButtonState === StartGenButtonStates.NotGenerating) {
        setStartGenTxt(``);
        // TODO: Updating page looses state
        // TODO: If fetch fails now it is unclear if the generation started or not.
        // TODO: Fetch db state to see the last transaction
        // Keep the button state for now but fix with constant state polling later.
        setStartGenButtonState(StartGenButtonStates.Generating);
        const params = GenParametersValidator.parse({
          userCount: genTransactionUserCount.props.value,
          dateFrom: new Date(genTransactionDateFrom).getTime(),
          dateTo: new Date(genTransactionDateTo).getTime(),
          transactionCount: genTransactionTransactionCount.props.value,
          maxDelayMs: genTransactionMaxDelayMs.props.value,
          minUserId: genTransactionMinUserId.props.value,
          minTransactionId: genTransactionMinTransactionId.props.value
        });
        logger.info(`Starting generation with params: ${JSON.stringify(params)}`);
        await fetchHandleAuth(gqlp.startGen.fetchCall.bind(gqlp.startGen, gqlp.GQL_URL), params);
        // TODO: add task id in the request and progress report
        // to make sure that progress report is relevant
        recoverGenButton();
      } else {
        await fetchHandleAuth(gqlp.stopGen.fetchCall.bind(gqlp.stopGen, gqlp.GQL_URL), undefined);
        recoverGenButton();
        logger.info("Stop generation already called, waiting for previous Start generation to finish");
      }
    } catch (err) {
      // TODO: when stopGen yields error but generation is running last progress report
      // will overwrite this error message. Fix it (More states?).
      setStartGenTxt(`Generation eror at state ${startGenButtonState}: ${err}`);
      recoverGenButton();
    }
  }

  //------- Get Users----------------
  const [getStatementDateFrom, setGetStatementDateFrom] = useState("");
  const [getStatementDateTo, setGetStatementDateTo] = useState("");
  const getStatementDateFromElement = dateTimeInput("From", [getStatementDateFrom, setGetStatementDateFrom], undefined, getStatementDateTo);
  const getStatementDateToElement = dateTimeInput("To", [getStatementDateTo, setGetStatementDateTo], getStatementDateFrom);
  const usersMaxCount = 100;
  const showUserListButtons = useRef(false)
  async function onUserSelected(user: UserOption | null) {
    if (user) {
      const dateRange = await fetchHandleAuth(gqlp.getTransactionDatesForUser.fetchCall.bind(gqlp.getTransactionDatesForUser, gqlp.GQL_URL), { userId: user.id });
      setGetStatementDateFrom(localTimeStringFromUtcMS(dateRange.minDate ?? 0));
      setGetStatementDateTo(localTimeStringFromUtcMS(dateRange.maxDate ?? 0));
      // setStatement({ ...statement, fromm: dateRange.minDate??0, too: dateRange.maxDate??0 });
      logger.info(`User ${user.id} date range: `, dateRange);
    }
  }
  async function fetchUsers(value: string, menuItem?: UserOption) {
    value = "%" + value + "%";
    const params: UserDataRequestParameters = { pattern: value, count: usersMaxCount, cursor: menuItem?.cursor };
    logger.info(`Fetching users with params:`, params, value, menuItem);
    const res = await fetchHandleAuth(gqlp.users.fetchCall.bind(gqlp.users, gqlp.GQL_URL), params) as UserDataResult;
    showUserListButtons.current = res.totalCount > res.slice.length;
    return res.slice.map(u => ({ value: `${u.name} (id: ${u.id})`, id: u.id, label: `${u.name} (${u.id})`, cursor: u.cursor }))
  }
  const initLoad = useRef(true);
  const userSelectElement = getUserSelectItem<UserOption>(fetchUsers, onUserSelected, showUserListButtons.current,
    56 /* to match TextField height*/, initLoad.current);
  initLoad.current = false;

  //------- Render statement ----------------
  const offset = useRef(0)
  const totalTransactionCount = useRef(0)
  const userIdRef = useRef<number|undefined>(undefined)
  const statementMaxLines = 50;
  const [transactions, setTransactions] = useState<Array<StatementChild>>([]);
  async function handleStatementFetch() {
    const selectedUserForStatement = userSelectElement.props.value;
    if (selectedUserForStatement.length === 0) {
      userIdRef.current = undefined;
      return;
    }
    userIdRef.current = selectedUserForStatement[0].id;
    const fromm = new Date(getStatementDateFrom).getTime();
    const too = new Date(getStatementDateTo).getTime();
    const params = StatementParametersValidator.parse({
        userId: userIdRef.current, fromm, too, offset: offset.current, count: statementMaxLines, type: StatementType.DS
    })
    const res = await fetchHandleAuth(gqlp.getStatement.fetchCall.bind(gqlp.getStatement, gqlp.GQL_URL), params) as StatementRequestResult;
    logger.info(`Fetching statement`, params, res);
    const checkIds = new Set<number>();
    res.transactions.forEach(t => checkIds.add(t.id));
    if (checkIds.size != res.transactions.length) {
      logger.warn(`Duplicate transactions received in:`, res.transactions);
      setTransactions(res.transactions.map((t, idx) => ({...t, key: idx})));
    } else {
      setTransactions(res.transactions);
    }
    totalTransactionCount.current = res.totalCount;
  }
  const transactionList = StatementContainer(transactions, offset.current, () => {
    offset.current = Math.max(0, offset.current - statementMaxLines);
    handleStatementFetch();
  }, () => {
    offset.current = Math.min(totalTransactionCount.current - statementMaxLines, offset.current + statementMaxLines);
    handleStatementFetch();
  }, offset.current > 0, transactions.length + offset.current < totalTransactionCount.current, userIdRef.current);
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Create Transaction */}
      <Paper sx={{ p: 3, mb: 4 }}>
      <Typography variant="h6" gutterBottom>
          Docs: <a href="doc.html">doc.html</a>
        </Typography>
        <Typography variant="h6" gutterBottom>
          Create Transaction
        </Typography>
        <Grid container spacing={2}>
          {[postTranactionDate,
            postTransactionUserIdFrom,
            postTransactionUserIdTo,
            postTransactionAmount].map((el, idx) =>
              <Grid item xs={12} sm={6} key={idx}>{el}</Grid>)}
          <Grid item xs={12} key={10}>
            {makeButton("Create Transaction", () => postButtonState, postTransaction)}
            {label(() => postedStasTxt)}
          </Grid>
        </Grid>
      </Paper>
      {/* Generate Transactions */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Generate Transactions
        </Typography>
        <Grid container spacing={2}>
          {[genTransactionDateFromElement,
            genTransactionDateToElement,
            genTransactionUserCount,
            genTransactionTransactionCount,
            genTransactionMinUserId,
            genTransactionMinTransactionId,
            genTransactionMaxDelayMs].map((el, idx) =>
              <Grid item xs={12} sm={6} key={idx}>{el}</Grid>)}
          <Grid item xs={12} container spacing={2} key={10}>
            {makeButton(() => startGenButtonStates.get(startGenButtonState)!.buttonLabel,
              () => startGenButtonStates.get(startGenButtonState)!.buttonDisabled, startGeneration)}
            {label(() => startGenTxt)}
          </Grid>
        </Grid>
      </Paper>

      {/* Get Statement */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Get Statement
        </Typography>
        <Grid container spacing={2}>
          {[userSelectElement,
            getStatementDateFromElement,
            getStatementDateToElement].map((el, idx) =>
              <Grid item xs={12} sm={4} key={idx}>{el}</Grid>)}
          <Grid item xs={12}  key={10}>
            <Button variant="contained" onClick={handleStatementFetch}>
              Fetch Statement
            </Button>
          </Grid>
          <Grid item xs={12} key={11}>
            <Button variant="contained" onClick={handleStatementFetch}>
              Download Statement
            </Button>
          </Grid>
        </Grid>
      </Paper>
      {/* Output */}
      <Paper sx={{ p: 3, mb: 4 }}>
        {transactionList}
      </Paper>
    </Container>
  );
}
