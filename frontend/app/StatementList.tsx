import React from 'react';
import { renderMenuButton } from './SuperButton';
import { Transaction } from '../common/event_types';
import Box from '@mui/material/Box';
import Grid from '@mui/material/Grid';


// Simple container component - just handles the scrolling structure
export const StatementContainer = ( 
  children: Transaction[], 
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
    {children.map((_, idx) => (
      <Box key={idx} maxWidth='4em'>{(offset + idx).toFixed().padStart(4, ' ') + ". "}</Box>
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

// Example usage
// const BankStatementExample = () => {
//   const [isLoading, setIsLoading] = React.useState(false);
  
//   const handleLoadEarlier = () => {
//     setIsLoading(true);
//     // Your API call here
//     setTimeout(() => setIsLoading(false), 1000);
//   };
  
//   const handleLoadLater = () => {
//     setIsLoading(true);
//     // Your API call here  
//     setTimeout(() => setIsLoading(false), 1000);
//   };

//   return (
//     <div className="max-w-2xl mx-auto p-6">
//       <h1 className="text-xl font-bold mb-4">Bank Statement</h1>
      
//       <StatementContainer
//         onLoadEarlier={handleLoadEarlier}
//         onLoadLater={handleLoadLater}
//         isLoading={isLoading}
//       >
//         {/* Your transaction rows go here */}
//         <div className="p-3 border-b">Transaction 1: Coffee Shop -$4.50</div>
//         <div className="p-3 border-b">Transaction 2: Salary +$3500.00</div>
//         <div className="p-3 border-b">Transaction 3: Gas Station -$45.20</div>
//         <div className="p-3 border-b">Transaction 4: Grocery Store -$87.32</div>
//         <div className="p-3 border-b">Transaction 5: ATM Withdrawal -$60.00</div>
//         <div className="p-3 border-b">Transaction 6: Restaurant -$28.90</div>
//         <div className="p-3 border-b">Transaction 7: Online Transfer -$150.00</div>
//         <div className="p-3">Transaction 8: Interest Payment +$12.45</div>
//       </StatementContainer>
//     </div>
//   );
// };

// export default BankStatementExample;