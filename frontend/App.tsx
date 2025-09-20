import React, { Children, useRef, useState } from "react";
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';

import Select, { InputActionMeta, components } from 'react-select'
import { GenerationState, GenParametersValidator, PostTransactionValidator, ProgressReport } from "./common/generator_parameters.js";
import * as gqlp from "./common/gqlDeclarations.js"
import z, { ZodObject } from "zod";
import { logger } from "./common/logger.js";
import { StatementParametersValidator, StatementType, UserDataRequestParameters } from "./common/event_types.js";
import { last } from "./common/utils.js";

enum StartGenButtonStates {
  NothingHappens,
  CalledToStartGeneration,
  CalledToStopGeneration
}
const startGenButtonStates = new Map<StartGenButtonStates, {buttonLabel: string, buttonDisabled: boolean}>([
  [StartGenButtonStates.NothingHappens, {buttonLabel: "Start Generation", buttonDisabled: false}],
  [StartGenButtonStates.CalledToStartGeneration, {buttonLabel: "Stop Generation", buttonDisabled: false}],
  [StartGenButtonStates.CalledToStopGeneration, {buttonLabel: "Stop Generation", buttonDisabled: true}]])

type Params<T>= {
  [K in keyof T]: string;
}
function makeParamsState<T extends ZodObject, K extends z.infer<T>>(shape: T): Required<Params<K>> {
  return Object.fromEntries(Object.keys(shape.shape).map((key) => [key, ""])) as Required<Params<K>>
}
const GQL_URL = "/graphql";

function dateTimeInput(lab: string, val: number, updateVal: (val: number) => void) {
  return <TextField
    fullWidth
    label={lab}
    type="datetime-local"
    InputLabelProps={{ shrink: true }}
    inputProps={{
      step: 1 // allows seconds
    }}
    value={new Date(val).toISOString().slice(0, -1)}
    onChange={(e) => updateVal(new Date(e.target.value).getTime())}
  />
}
function textInput<T>(lab: string, val: T, updateVal: (v: T) => void,  type: 'text' | 'number' =  'text') {
  return <TextField
    fullWidth
    label={lab}
    value={typeof val == 'number' ? val.toString() : val}
    onChange={
      (e) => {
        // logger.info(`Date input changed to`, e);
        updateVal((type == 'number' ? Number.parseInt(e.target.value) : e.target.value) as T)
      }
    }
    type={type}
  />
}
function makeButton<T>(lab: string|(() => string), toggler: () => boolean, onClick: () => void) {
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

export default function App() {
  //------ Post Transaction----------------
  const [postTransactionParams, setPostTransactionParams] = useState(PostTransactionValidator.parse({
    date: new Date().getTime(),
    userFrom: 1,
    userTo: 1,
    amount: 100
  }));
  const postedStas = useRef({success: 0, failed: 0});
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
    // const params = PostTransactionValidator.parse(postTransactionParams);
    gqlp.postTransaction.fetchCall(GQL_URL, gqlp.postTransaction.coercedParamType!.parse(postTransactionParams)).then(_ => {
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
  const [genParams, setGenParams] = useState(() => {
    const now = new Date();
    const before = new Date();
    before.setFullYear(before.getFullYear() - 25);
    return {
    dateFrom: before.getTime(),
    dateTo: now.getTime(),
    userCount: 10000,
    transactionCount: 1000000,
    minUserId: 1,
    minTransactionId: 1,
    maxDelayMs: 100
  }});
  const [startGenButtonState, setStartGenButtonState] = useState(StartGenButtonStates.NothingHappens);
  async function startGeneration() {
    try {
      if (startGenButtonState === StartGenButtonStates.NothingHappens) {
        setStartGenTxt(``);
        // TODO: Updating page looses state
        // TODO: If fetch fails now it is unclear if the generation started or not.
        // Keep the button state for now but fix with constant state polling later.
        setStartGenButtonState(StartGenButtonStates.CalledToStartGeneration);
        const params = GenParametersValidator.parse(genParams);
        logger.info(`Starting generation with params: ${JSON.stringify(params)}`);
        await gqlp.startGen.fetchCall(GQL_URL, params);
      } else if (startGenButtonState === StartGenButtonStates.CalledToStartGeneration) {
        // Disable the button until the previously called startGen is finished asynchroniously
        setStartGenButtonState(StartGenButtonStates.CalledToStopGeneration);
        await gqlp.stopGen.fetchCall(GQL_URL)
        return;
      } else {
        logger.info("Stop generation already called, waiting for previous Start generation to finish");
        return;
      }
    } catch (err) {
      // TODO: when stopGen yields error but generation is running last progress report
      // will overwrite this error message. Fix it (More states?).
      setStartGenTxt(`Generation eror at state ${startGenButtonState}: ${err}`);
      return;
    }
    let interval = 100;
    const startTime = Date.now();
    let runNum = 0;
    let lastProgressReport: ProgressReport | undefined = undefined;
    try {
      while (true) {
        runNum++;
        await new Promise(resolve => setTimeout(resolve, interval));
        lastProgressReport = await gqlp.getProgress.fetchCall(GQL_URL);
        genParams.minUserId = lastProgressReport.maxUserId;
        genParams.minTransactionId = lastProgressReport.maxTransactionId;
        setGenParams({...genParams});
        const now = Date.now();
        if (lastProgressReport.isRunning === GenerationState.STOPPED) {
            setStartGenButtonState(StartGenButtonStates.NothingHappens);
            setStartGenTxt(`Generation done. Elapsed: ${now - startTime}, generated ${lastProgressReport.generated}.`);
            break;
        }
        const elapsed = Math.max((now - startTime), 1)
        const completionRate = elapsed / Math.max(1, lastProgressReport.percentComplete);
        const timeToFinish = completionRate * (100 - lastProgressReport.percentComplete);
        interval = Math.min(2000, Math.max(1000, timeToFinish));
        setStartGenTxt(`Progress: ${JSON.stringify(lastProgressReport)}. Elapsed: ${now - startTime}.`);
      }
    } catch (err) {
      // TODO: maybe it is worth sending progress requests non-stop 
      // and show the real time generation state even when no generation is running
      setStartGenButtonState(StartGenButtonStates.NothingHappens);
      setStartGenTxt(`Error during generation. 
        Last progress report: ${JSON.stringify(lastProgressReport)}.
        Error: ${err}.`);
    }
  }


  //------- Get Users----------------
  const [output, setOutput] = useState<string>("");
  function renderMenuButton(label: string, show: () => boolean, refreshOptions: () => void) {
    if (!show()) {
      return <div></div> 
    } else {
      return <div
          style={{
            borderTop: "1px solid #ccc",
            padding: "6px 8px",
            textAlign: "center",
            background: "#f9f9f9",
          }}
        >
          <button
            type="button"
            onClick={e => {
              e.stopPropagation();  // prevent menu from closing
              refreshOptions();
            }}
          >
            {label}
          </button>
        </div>
      }
    }

    const userPatternDebounceState = useRef<{timer?: NodeJS.Timeout, lastValue: string, 
      isLookingUp: boolean, 
      scheduled?: UserDataRequestParameters
      menuItems?: {top: number, bot: number}}>({lastValue: "", isLookingUp: false, scheduled: {
        pattern: "", count: 100
      }});

    const [ selected, setSelected] = useState<UserOption[] | null>(null);
    type UserOption = {
      value: string;
      label: string;
      cursor: number;
    };
    const [optionsUserNames, setFoundUserData] = useState<UserOption[]>([]);
    const [isLockedForUserRetrieval, lockUserRetrieval] = useState(false);
    const globalIdx = useRef<number>(0);
    const defUseStat = useRef<() => string>(() => { 
      logger.error("Creating new last Input!", globalIdx.current++);
      return "";});
    const [lastInput, setLastInput] = useState(defUseStat.current());

    const DEBOUNCE_INTERVAL_MS = 800;
    if (optionsUserNames.length === 0) {
      requestUserList();
    }


    async function handleInputChange(newValue: string, actionMeta: InputActionMeta) {
      if ( actionMeta.action === 'input-blur' 
        || actionMeta.action === 'menu-close' 
        || actionMeta.action === 'set-value'
        || newValue == actionMeta.prevInputValue) {
        return;
      }
      userPatternDebounceState.current.lastValue = newValue;
      setLastInput(newValue);
      debounce();
    }
    function debounce() {
      clearTimeout(userPatternDebounceState.current.timer);
      userPatternDebounceState.current.timer = setTimeout(() => {
        userPatternDebounceState.current.scheduled = {
          pattern: userPatternDebounceState.current.lastValue,
          count: 100
        };
        requestUserList();
      }, DEBOUNCE_INTERVAL_MS);
    }
    async function requestUserList() {
      if (userPatternDebounceState.current.isLookingUp || 
        userPatternDebounceState.current.scheduled === undefined) {
        return;
      }
      lockUserRetrieval(true);
      userPatternDebounceState.current.isLookingUp = true;
      try {
        while (userPatternDebounceState.current.scheduled) {
          const params = userPatternDebounceState.current.scheduled;
          userPatternDebounceState.current.scheduled = undefined;
          params.pattern = "%" + params.pattern + "%";
          const res = await gqlp.users.fetchCall(GQL_URL, params);
          setFoundUserData(res.slice.map(u => ({value: `${u.name} (id: ${u.id})`, label: `${u.name} (${u.id})`, cursor: u.cursor})));
        }
      } catch (err) {
        setOutput(JSON.stringify(err));
      }
      lockUserRetrieval(false);
      userPatternDebounceState.current.isLookingUp = false;
    }
    const refreshOptionsTop = () => {
      userPatternDebounceState.current.scheduled = {
        pattern: userPatternDebounceState.current.lastValue,
        count: 100,
        cursor: userPatternDebounceState.current.menuItems?.top // top displayed value
      };
      requestUserList();
    };
    const refreshOptionsBot = () => {
      userPatternDebounceState.current.scheduled = {
        pattern: userPatternDebounceState.current.lastValue,
        count: 100,
        cursor: userPatternDebounceState.current.menuItems?.bot // top displayed value
      };
      requestUserList();
    };

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const scrollPos = useRef(0);
    const scrollHandler = useRef<(e: Event) => void>((e: Event) => {
      scrollPos.current = (e.target as HTMLDivElement).scrollTop;
    });

    const MenuList = (props: any) => {
    const children = Children.toArray(props.children);
    const selected = {
      top: Object(children[0])?.props?.data?.cursor,
      bot: Object(last(children))?.props?.data?.cursor
    };
    if (selected.top !== undefined && selected.bot !== undefined) {
      userPatternDebounceState.current.menuItems = selected;
    }
    return (
    <components.MenuList {...props}
    innerRef={(ref: HTMLDivElement) => {
      if (ref) {
        scrollRef.current?.removeEventListener('scroll', scrollHandler.current);
        scrollRef.current = ref;
        ref.addEventListener('scroll', scrollHandler.current);
        ref.scrollTop = scrollPos.current;
      }
    }}
    >
      {renderMenuButton("🔄 Refresh Options (top)", () => optionsUserNames.length > 0, refreshOptionsTop)}
      {props.children} {/* regular options */}
      {renderMenuButton("🔄 Refresh Options (bot)", () => optionsUserNames.length > 0, refreshOptionsBot)}
    </components.MenuList>
  )};







  //------- Render statement ----------------
  const [statement, setStatement] = useState(StatementParametersValidator.parse({userId: 1, type: StatementType.FS}));
  // Simulate statement fetch

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Create Transaction */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Create Transaction
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date", postTransactionParams.date, (v) => 
              setPostTransactionParams({ ...postTransactionParams, date: v })
            )}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Id From", postTransactionParams.userFrom, (v) => setPostTransactionParams({ ...postTransactionParams, userFrom: v}), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Id To", postTransactionParams.userTo, (v) => setPostTransactionParams({ ...postTransactionParams, userTo: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Amount", postTransactionParams.amount, (v) => setPostTransactionParams({ ...postTransactionParams, amount: v }), "number")}
          </Grid>
          <Grid item xs={12}>
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
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date From", genParams.dateFrom, (v) => setGenParams({ ...genParams, dateFrom: v }))}
          </Grid>
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date To", genParams.dateTo, (v) => setGenParams({ ...genParams, dateTo: v }))}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Count", genParams.userCount, (v) => setGenParams({ ...genParams, userCount: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Transactions Count", genParams.transactionCount, (v) => setGenParams({ ...genParams, transactionCount: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Min User Id",  genParams.minUserId, (v) => setGenParams({ ...genParams, minUserId: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Min Transaction Id",  genParams.minTransactionId, (v) => setGenParams({ ...genParams, minTransactionId: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Transaction Result Delay Ms.",  genParams.maxDelayMs, (v) => setGenParams({ ...genParams, maxDelayMs: v }), "number")}
          </Grid>
          <Grid item xs={12} spacing={2}>
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
          <Grid item xs={12} sm={4}>
            <Select 
              value={selected}
              inputValue={lastInput}
              placeholder="Select User"
              isMulti={true}
              isClearable={false}
              options={optionsUserNames}
              onInputChange={handleInputChange}
              closeMenuOnSelect={false}
              onChange={(newValue, actionMeta) => {
                // Using isMulti={true} and taking only last item is a hack to keep 
                // the input text in the input field after the menu is closed in any way.
                // Doing it with single selection hides the selected value on the second
                // manual menu close
                // Reproduction with isMulti={false}: 
                // 1) Type some input
                // 2) Select item with input text still there
                // 3) close-open-close the menu with mouse click
                // Now any text is gone amd only "x" mark remains.
                if (newValue.length === 0) {
                  setSelected(null);
                  return;
                }
                setSelected([last(newValue as UserOption[])!]);
              }}
              styles={{control: (base: any) => ({
                ...base,
                minHeight: 56
              })
            }}
              isLoading={isLockedForUserRetrieval}
              components={{MenuList}}
              />
          </Grid>
          <Grid item xs={12} sm={4}>
            {dateTimeInput("From Date", statement.fromm??0, (v) => setStatement({ ...statement, fromm: v }))}
          </Grid>
          <Grid item xs={12} sm={4}>
            {dateTimeInput("From Date", statement.too??0, (v) => setStatement({ ...statement, too: v }))}
          </Grid>
          <Grid item xs={12}>
            <Button variant="contained" onClick={() => {}}>
              Fetch Statement
            </Button>
          </Grid>
        </Grid>
      </Paper>

      {/* Output */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Output
        </Typography>
        <Box
          component="pre"
          sx={{
            bgcolor: "#f5f5f5",
            p: 2,
            height: 200,
            overflow: "auto",
            whiteSpace: "pre-wrap",
          }}
        >
          {output || "No output yet."}
        </Box>
      </Paper>
    </Container>
  );
}
