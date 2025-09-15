import React, { useState } from "react";
import {
  Container,
  Box,
  Typography,
  TextField,
  Button,
  Grid,
  Paper
} from "@mui/material";

import Select, { InputActionMeta } from 'react-select'
import { GenParameters, GenParametersValidator, PostTransactionValidatorGql } from "./common/generator_parameters.js";
import * as gqlp from "./common/gqlDeclarations.js"
import { number } from "zod";

class ValueRef {
  val: string = "";
}
type Params<T>= {
  [K in keyof T]: ValueRef;
}

const postedStas = {success: 0, failed: 0};
export default function App() {
  const [tx, setTx] = useState({
    date: new ValueRef,
    userFrom: new ValueRef,
    userTo: new ValueRef,
    amount: new ValueRef,
  });
  const [statement, setStatement] = useState({
    user: new ValueRef,
    fromDate: new ValueRef,
    toDate: new ValueRef,
  });
  const [output, setOutput] = useState<string>("");
  // GenParametersValidator.shape
  const getParamsState = Object.fromEntries(Object.keys(GenParametersValidator.shape).map(
    (key) => [key, new ValueRef()]
  )) as Params<GenParameters>
  // getParamsState.dateFrom.val = "10";
  const [genParams, setGenParams] = useState(getParamsState);

  // Simulate Kafka call
  const handleCreateTransaction = () => {
    // Replace with API call
    setOutput((prev) =>
      prev +
      `Created transaction: ${JSON.stringify(tx)}\n`
    );
  };
  function startGenerate() {
    
  }
  const setPostedStatsTxt = () => {
    if (postedStas.success === 0 && postedStas.failed === 0) {
      postedStasTxt.val = "";
      setPostedStats({...postedStasTxt});
      return;
    }
    let txt = `Posted: ${postedStas.success}`;
    if (postedStas.failed > 0) {
      txt += `, Failed: ${postedStas.failed}`;
    }
    postedStasTxt.val = txt;
    console.log("Setting posted stats", txt);
    setPostedStats({...postedStasTxt});
  }
  const [postedStasTxt, setPostedStats] = useState(new ValueRef);
  const [lastPostError, setLastPostError] = useState(new ValueRef);

  function postTransaction() {
    const params = PostTransactionValidatorGql.parse({amount: tx.amount.val,
      userFrom: tx.userFrom.val,
      userTo: tx.userTo.val,
      date: Math.floor(new Date(tx.date.val).getTime()).toFixed(0)
    });
    gqlp.postTransaction.fetchCall('/graphql', params).then(_ => {
      postedStas.success++;
      lastPostError.val = "";
    }).catch(err => {
      postedStas.failed++;
      lastPostError.val = err.message;
    }).finally(() => {
      setPostedStatsTxt()
      setLastPostError({...lastPostError});
    });
  }
  function getGenerationProgress() {
    
  }
  function getStatement() {

  }
  // Simulate statement fetch
  const handleGetStatement = () => {
    // Replace with API call
    setOutput((prev) =>
      prev +
      `Fetched statement for ${statement.user} from ${statement.fromDate} to ${statement.toDate}\n`
    );
  };
  const progress = new ValueRef;
  type UserOption = {
    value: string;
    label: string;
  };
  const [options, setOptions] = useState<UserOption[]>([]);
  const [selected, setSelected] = useState<UserOption | null>(null);

  const dateTimeInput = (lab: string, str: Object, field: ValueRef, setter: (val: any) => void) => {
    return <TextField
      fullWidth
      label={lab}
      type="datetime-local"
      InputLabelProps={{ shrink: true }}
      inputProps={{
        step: 1 // allows seconds
      }}
      value={field.val}
      onChange={(e) => {
        field.val = e.target.value;
        setter({...str})
      }}
    />
  }

  const [genProgress, setGenProgress] = useState(new ValueRef);

  const textInput = (lab: string, str: Object, field: ValueRef, setter: (val: any) => void, type: 'text' | 'number' =  'text') => {
    return <TextField
      fullWidth
      label={lab}
      value={field.val}
      onChange={(e) => {
        field.val = e.target.value;
        setter({ ...str })
      }}
      type={type}
    />
  }
  function label(dataSrc: ValueRef) {
    return <Typography sx={{ mt: 2 }}>
      {dataSrc.val}
    </Typography>
  }
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      {/* Create Transaction */}
      <Paper sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" gutterBottom>
          Create Transaction
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date", tx, tx.date, setTx)}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Id From", tx, tx.userFrom, setTx, "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Id To", tx, tx.userTo, setTx, "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Amount", tx, tx.amount, setTx, "number")}
          </Grid>
          <Grid item xs={12}>
            <Button variant="contained" onClick={postTransaction}>
              Send to Kafka
            </Button>
            {label(postedStasTxt)}
            {label(lastPostError)}
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
            {dateTimeInput("Date From", genParams, genParams.dateFrom, setGenParams)}
          </Grid>
          <Grid item xs={12} sm={6}>
            {dateTimeInput("Date To", genParams, genParams.dateTo, setGenParams)}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("User Count", genParams, genParams.userCount, setGenParams, "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Transactions Count", genParams, genParams.transactionCount, setGenParams, "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Min User Id", genParams, genParams.minUserId!, setGenParams, "number")}
          </Grid>
          <Grid item xs={12} sm={6}>
            {textInput("Min Transaction Id", genParams, genParams.minTransactionId!, setGenParams, "number")}
          </Grid>
          <Grid item xs={12} spacing={2}>
            <Button variant="contained" onClick={handleCreateTransaction}>
              Generate
            </Button>
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
              placeholder="Select User"
              options={options}
              onInputChange={(newValue: string, actionMeta: InputActionMeta) => {
                console.log(`Input Changed: ${newValue}`, actionMeta);
                setOptions([...options, {value: newValue, label: newValue}])
              }}
              onChange={(newValue, actionMeta) => {
                console.log(`Value Changed: ${newValue}`, actionMeta);
              }}
              styles={{control: (base: any) => ({
                ...base,
                minHeight: 56
              })}}
              />
          </Grid>
          <Grid item xs={12} sm={4}>
            {dateTimeInput("From Date", statement, statement.fromDate, setStatement)}
          </Grid>
          <Grid item xs={12} sm={4}>
            {dateTimeInput("From Date", statement, statement.toDate, setStatement)}
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
