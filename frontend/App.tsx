import React, { useState, useRef, useLayoutEffect } from "react";
import {
  Container,
  Box,
  Typography,
  TextField,
  Button,
  Grid,
  Paper
} from "@mui/material";

import Select, { InputActionMeta, components } from 'react-select'
import { GenerationState, GenParametersValidator, GenParametersValidatorGql, PostTransactionValidatorGql, ProgressReport } from "./common/generator_parameters.js";
import * as gqlp from "./common/gqlDeclarations.js"
import z, { set, ZodObject } from "zod";
import { StatementParametersValidatorGql } from "./common/event_types.js";
import { fa } from "zod/v4/locales";
import { logger } from "./common/logger.js";

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

const dateTimeInput = (lab: string, val: () => string, updateVal: (val: string) => void) => {
  return <TextField
    fullWidth
    label={lab}
    type="datetime-local"
    InputLabelProps={{ shrink: true }}
    inputProps={{
      step: 1 // allows seconds
    }}
    value={val()}
    onChange={(e) => updateVal(e.target.value)}
  />
}
const textInput = (lab: string, val: () => string, updateVal: (v: string) => void,  type: 'text' | 'number' =  'text') => {
  return <TextField
    fullWidth
    label={lab}
    value={val()}
    onChange={(e) => updateVal(e.target.value)}
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
  return <Typography sx={{ mt: 2, minWidth: 0, whiteSpace: 'normal'}}>
    {toggler()}
  </Typography>
}








export default function App() {
  //------ Post Transaction----------------
  const [postTransactionParams, setPostTransactionParams] = useState(() => {
    const res = makeParamsState(PostTransactionValidatorGql)
    res.date = (new Date()).toISOString().slice(0, 19);
    res.userFrom = "1";
    res.userTo = "2";
    res.amount = "100";
    return res;
});
  const [postedStas, setPostedStats1] = useState({success: 0, failed: 0});
  const [postButtonState, setPostButtonState] = useState(false);
  const [postedStasTxt, renderPostedStatsTxt] = useState("");
  const [startGenTxt, setStartGenTxt] = useState("");
  const updatePostedStatsTxt = () => {
    if (postedStas.success === 0 && postedStas.failed === 0) {
      renderPostedStatsTxt("");
      return;
    }
    let txt = `Posted: ${postedStas.success}`;
    if (postedStas.failed > 0) {
      txt += `, Failed: ${postedStas.failed}`;
    }
    renderPostedStatsTxt(txt);
  }
  function postTransaction() {
    setPostButtonState(true);
    const params = PostTransactionValidatorGql.parse(postTransactionParams);
    gqlp.postTransaction.fetchCall(GQL_URL, params).then(_ => {
      postedStas.success++;
      updatePostedStatsTxt();
    }).catch(err => {
      postedStas.failed++;
      renderPostedStatsTxt(err.message);
    }).finally(() => {
      setPostButtonState(false);
    });
  }
  
  //------ Generate Transactions----------------
  const [genParams, setGenParams] = useState(() => {
    const res = makeParamsState(GenParametersValidator)
    const now = new Date();
    const before = new Date();
    before.setFullYear(before.getFullYear() - 25);
    res.dateFrom = before.toISOString().slice(0, 19);
    res.dateTo = now.toISOString().slice(0, 19);
    res.userCount = "10000";
    res.transactionCount = "1000000";
    res.minUserId = "1";
    res.minTransactionId = "1";
    res.maxDelayMs = "100";
    return res;
  });
  const [startGenButtonState, setStartGenButtonState] = useState(StartGenButtonStates.NothingHappens);
  async function startGeneration() {
    try {
      if (startGenButtonState === StartGenButtonStates.NothingHappens) {
        setStartGenTxt(``);
        // TODO: presense of manual transaction posting and the way progress is 
        // calculated might produce non critical edge cases which could be addressed
        // Remark: updating web page during the generation will drop all ui state
        // without stopping the generation. Startning new one will cancel the old one.
        // This behavior is decided to be acceptable.
        setStartGenButtonState(StartGenButtonStates.CalledToStartGeneration);
        const params = GenParametersValidatorGql.parse(genParams);
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
        genParams.minUserId = lastProgressReport.maxUserId.toString();
        genParams.minTransactionId = lastProgressReport.maxTransactionId.toString();
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


  //------- Get Statement----------------
  const [statement, setStatement] = useState(makeParamsState(StatementParametersValidatorGql));
  // Simulate statement fetch
  const handleGetStatement = () => {

  };
  // need to do the following:
  // 1. if i typed a user name...any change while typing looks up top 100 user names
  // 2. if i scroll the user list, then i need a trigger to upload the next users and populate the whole list as i scroll
  //  2.1 may test this list repopulation with dummy data - when i scroll to the end of the list, generate last 30 items and remove 30 items from the top

  type UserOption = {
    value: string;
    label: string;
  };
  let idx = 0;
  const [foundUserData, setFoundUserData] = useState<UserOption[]>([
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`},
    {value: `someval${idx++}`, label: `somelab${idx++}`}]);
  const [selected, setSelected] = useState<UserOption | null>(foundUserData[0]);

  //------- Render statement ----------------
  const [output, setOutput] = useState<string>("");
  const [scrollState, setScrollState] = useState(true);
  
  const refreshOptionsTop = () => {
    setFoundUserData([
      { value: `TV${foundUserData.length + 1}`, label: `TL${foundUserData.length + 1}` },
      { value: `TV${foundUserData.length + 2}`, label: `TL${foundUserData.length + 2}` },
      { value: `TV${foundUserData.length + 3}`, label: `TL${foundUserData.length + 3}` },
      ...foundUserData.slice(0, -3)
    ]);
  };
  
  const refreshOptionsBot = () => {
    if (menuRef.current) {
      // remember scroll before adding
      scrollPos.current = menuRef.current.scrollTop;
    }
    setFoundUserData([...foundUserData.slice(3),
      { value: `bV${foundUserData.length + 1}`, label: `bL${foundUserData.length + 1}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` },
      { value: `bV${foundUserData.length + 2}`, label: `bL${foundUserData.length + 2}` }
    ]);
  };
  const [showTopMenu, setShowTopMenu] = useState(true);
  const [showBottonMenu, setShowBottomMenu] = useState(true);
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

    const [menuOpen, setMenuOpen] = useState(false);
    const [isLockedForUserRetrieval, lockUserRetrieval] = useState(false);
    const [lastInput, setLastInput] = useState("");
    const [lastInputTime, setLastInputTime] = useState(0);
    const [lastRequestedUserList, setLastRequestedUserList] = useState("");
    const [waitingToCommitSelectValue, setWaitingToCommitSelectValue] = useState(false);
    const [inpuHandleTO, setInpuHandleTO] = useState<NodeJS.Timeout | undefined>(undefined);
    const [showTopUserMenuButton, setShowTopUserMenuButton] = useState(true);
    const [showBottomUserMenuButton, setShowBottomUserMenuButton] = useState(true);
    const DEBOUNCE_INTERVAL_MS = 800;
    function requestNewUserList() {
      
    }
    function requestUserList() {
      const filter = lastInput;
      if (lastRequestedUserList == lastInput) {
        // already requested this value
        // but need a different subset of it

      }
      // need to get the regular expression
      /*
        Request can be triggered in the following cases:
        1. user typed something - then i need to get top 100 users matching the input
        2. user requested nexxt 100 items with menu button - then i need to get the new top user id and request next 100 users matching the input
        the user composition could have changed between requests so i need to be ready that i might loose 
        all the records and get completely new lixt of users. in any case i need to kep some user id in mind,
        so that when i get it, i can update items and set the scroll position to its new location

        [1,2,3,4,5,6,7,8,9,10]

        i get [1,2,3,4]
        i want to render next 2 and stay at 4
        i ask for (startid: 3, count: 4)

        i might get [3,4,5,6] if nothing changes and i navigate to 4
        i might get [30,31,32,33] if everything changed and i navigate to 30
        i might get [3,6,10] if something changed and i navigate to 6
        i might even get [5,9,10,11] and i navigate to 5


        3. user scrolled to the top of the list - then i need to get previous 100 users matching the input
        
        [1,2,3,4,5,6,7,8,9,10]


        i get [7,8,9,10]
        i want to render previous 2 and stay at 7
        this is tricky because i don't know the coursor value for the previous value....
      */
      lockUserRetrieval(true);
      // handleinput - request dp
      new Promise<void>(r => setTimeout(() => { //placeholder promise for data lookup
        lockUserRetrieval(false);
        r()
      }, 3000));
    }
    function checkDebouncedUserListRequest() {
      if (waitingToCommitSelectValue) {
        if (inpuHandleTO) {
          //ignore because i wm waiting for user to stop typing
        } else {
          // It means the timer has just stopped 
          //  and now i need to check the current state, 
          //  which is inaccessible from timer's callback
          // TODO: should i make a value refrence for the state used for this pacing?
          const now = Date.now();
          if (now - lastInputTime >= DEBOUNCE_INTERVAL_MS) {
            requestUserList();
          } else {
            debounce(); // restart the timer
          }
        }
      }
    }
    function debounce() {
      setWaitingToCommitSelectValue(true);
      setInpuHandleTO(setTimeout(() => {
        //trigger rerender to check the state
        setInpuHandleTO(undefined);
      }, DEBOUNCE_INTERVAL_MS));
    }
    async function handleInputChange(newValue: string, actionMeta: InputActionMeta) {
      if (newValue == actionMeta.prevInputValue) {
        return;
      }
      setLastInput(newValue); // set a timer tomake sure i am not just working on every keystoke
      setLastInputTime(Date.now());
      if (inpuHandleTO || isLockedForUserRetrieval) {
        // Already waiting or extracting users. 
        // When extraction is done, ignore updated input, wait for new updates + debounce.
        return; 
      }
      debounce();
    }

    function saveMenuListPos() {
      if (menuRef.current) {
        // remember scroll before adding
        //so scrollTop returns element's position relative to the top of the scrollable area
        // so i remember pixer position, not the element's actual position.
        scrollPos.current = menuRef.current.scrollTop;
      }
    }
    checkDebouncedUserListRequest();
    const menuRef = useRef<HTMLDivElement | null>(null);
    const scrollPos = useRef(0);
    
    // restore scroll AFTER options update
    useLayoutEffect(() => {
      if (menuOpen && menuRef.current) {
        menuRef.current.scrollTop = scrollPos.current;
      }
    }, [foundUserData, menuOpen]);
    
  const MenuList = (props: any) => (
    <components.MenuList {...props} innerRef={menuRef}>
      {renderMenuButton("🔄 Refresh Options (top)", () => showTopUserMenuButton, refreshOptionsTop)}
      {props.children} {/* regular options */}
      {renderMenuButton("🔄 Refresh Options (bot)", () => showBottomUserMenuButton, refreshOptionsBot)}
    </components.MenuList>
  );



  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Create Transaction */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Create Transaction
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date", () => postTransactionParams.date, (v) => setPostTransactionParams({ ...postTransactionParams, date: v }))}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Id From", () => postTransactionParams.userFrom, (v) => setPostTransactionParams({ ...postTransactionParams, userFrom: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Id To", () => postTransactionParams.userTo, (v) => setPostTransactionParams({ ...postTransactionParams, userTo: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Amount", () => postTransactionParams.amount, (v) => setPostTransactionParams({ ...postTransactionParams, amount: v }), "number")}
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
            {dateTimeInput("Date From", () => genParams.dateFrom, (v) => setGenParams({ ...genParams, dateFrom: v }))}
          </Grid>
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date To", () => genParams.dateTo, (v) => setGenParams({ ...genParams, dateTo: v }))}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Count", () => genParams.userCount, (v) => setGenParams({ ...genParams, userCount: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Transactions Count", () => genParams.transactionCount, (v) => setGenParams({ ...genParams, transactionCount: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Min User Id",  () => genParams.minUserId, (v) => setGenParams({ ...genParams, minUserId: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Min Transaction Id",  () => genParams.minTransactionId, (v) => setGenParams({ ...genParams, minTransactionId: v }), "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Transaction Result Delay Ms.",  () => genParams.maxDelayMs, (v) => setGenParams({ ...genParams, maxDelayMs: v }), "number")}
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
              options={(() => {
                logger.info(`Rendering select with ${foundUserData.length} options is open ${menuOpen}`);
                return foundUserData
              })()}
              onInputChange={handleInputChange}
              onChange={(newValue, actionMeta) => {
                //request
                console.log(`onChange: ${newValue}`, actionMeta);
                setStatement({ ...statement, userId: newValue? newValue.value : ""});
                setSelected(newValue);
              }}
              onMenuScrollToBottom={(event: WheelEvent | TouchEvent) => {
                console.log(`onMenuScrollToBottom: ${JSON.stringify(event)}`);
              }}
              styles={{control: (base: any) => ({
                ...base,
                minHeight: 56
              })}}
              isLoading={isLockedForUserRetrieval}
              components={{MenuList}}
              menuPlacement="auto"
              menuIsOpen={menuOpen}
              onMenuOpen={() => setMenuOpen(true)}
              onMenuClose={() => setMenuOpen(false)}
              />
          </Grid>
          <Grid item xs={12} sm={4}>
            {dateTimeInput("From Date", () => statement.fromm, (v) => setStatement({ ...statement, fromm: v }))}
          </Grid>
          <Grid item xs={12} sm={4}>
            {dateTimeInput("From Date", () => statement.too, (v) => setStatement({ ...statement, too: v }))}
          </Grid>
          <Grid item xs={12}>
            <Button variant="contained" onClick={handleGetStatement}>
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
