import React from 'react';
import { renderMenuButton } from './SuperButton';
import { Transaction } from '../../common/event_types';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';


export type StatementChild = Transaction & { key?: number }
// Simple container component - just handles the scrolling structure
export const StatementContainer = ( 
  children: StatementChild[], 
  offset: number,
  onLoadEarlier: () => void, 
  onLoadLater: () => void,
  showButtonTop = true,
  showButtonBot = true,
  userId?: number
) => {
  return !userId ? (<Box
    component="pre"
    sx={{
      bgcolor: "#f5f5f5",
      p: 2,
      height: 200,
      overflow: "auto",
  whiteSpace: "pre-wrap",
}}
></Box>) : (
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
      {renderMenuButton("↑", showButtonTop, onLoadEarlier)}
      <Grid container spacing={1}  wrap="nowrap">
  {/* Idx */}
  <Grid item flex={0} minWidth='4em'>
    <Box fontWeight="bold" mb={1} maxWidth='4em'>№</Box>
    {children.map((tx, idx) => (
      <Box key={tx.id} maxWidth='4em'>{(offset + idx).toFixed().padStart(4, ' ') + ". "}</Box>
    ))}
  </Grid>
  {/* Date column */}
  <Grid item flex={0} minWidth='14em'>
    <Box fontWeight="bold" mb={1} maxWidth='12em'>Date</Box>
    {children.map(tx => (
      <Box key={tx.id} maxWidth='12em'>{new Date(tx.dateTime).toISOString().slice(0, -5)}</Box>
    ))}
  </Grid>

  {/* Transaction ID column */}
  <Grid item flex={0} minWidth='12em' textAlign={"center"}>
    <Box fontWeight="bold" mb={1} textAlign={"center"}>Transaction ID</Box>
    {children.map(tx => (
      <Box key={tx.id}>{tx.id.toFixed().padStart(18, ' ')}</Box>
    ))}
  </Grid>

  {/* Vendor/User column */}
  <Grid item flex={0}>
    <Box fontWeight="bold" mb={1} textAlign={"center"}>Vendor/User</Box>
    {children.map(tx => (
      <Box key={tx.id} textAlign={"center"}>
        {userId === tx.userIdFrom ? tx.userIdTo : tx.userIdFrom}
      </Box>
    ))}
  </Grid>

  {/* Amount column */}
  <Grid item flex={1}>
    <Box fontWeight="bold" mb={1} textAlign={"right"}>Amount</Box>
    {children.map(tx => (
      <Box key={tx.id} textAlign={"right"}>
        {userId === tx.userIdTo ? tx.amount : -tx.amount}
      </Box>
    ))}
  </Grid>
</Grid>

      {renderMenuButton("↓", showButtonBot, onLoadLater)}
    </Box>
  );
};


        // {printLegend()}
        // {children.map(tx => 
        //   printData(tx, userId)
        // )}
// info: Transaction, userId: number
const printData = (info: Transaction, userId: number) => {
  return TransactionRow(new Date(info.dateTime).toISOString().slice(0, -1),
    info.id.toFixed(20), 
    userId === info.userIdFrom ? info.userIdTo : info.userIdFrom,
    userId === info.userIdTo ? info.amount : -info.amount)
}
const printLegend = () => {
  return TransactionRow("Date", "ID", "Other Party", "Amount");
}
  

const TransactionRow = (c1: any, c2: any, c3: any, c4: any) => (
  <Grid item xs={12}>
  <Box
    display="flex"
    justifyContent="space-between"
    alignItems="center"
    sx={{ fontFamily: "monospace" }}
  >
    {/* Left: ID */}
    <Box flexShrink={0}>
      {c1}
      {"    "}
      {c2}
    </Box>

    {/* Middle: other columns spread evenly */}
    <Box flex="1" textAlign="left" pl={2}>
      {c3}
    </Box>

    {/* Right: Amount */}
    <Box flexShrink={0}>
      {c4}
    </Box>
  </Box>
</Grid>
);
