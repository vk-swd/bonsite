import { gql, request } from 'graphql-request'
import { json } from 'stream/consumers';

const document1 = gql`
  {
    company {
      ceo
    }
  }
`


// async function loadData() {
//   const query = `
//     query GetStatement($from: String!, $to: String!) {
//       statement(from: $from, to: $to) {
//         timestamp
//         amount
//         description
//       }
//     }
//   `;

//   const variables = {
//     from: "2024-01-01",
//     to: "2024-12-31"
//   };

//   const res = await fetch("http://localhost:4000/graphql", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json"
//     },
//     body: JSON.stringify({
//       query,
//       variables
//     })
//   });

//   const data = await res.json();
//   document.getElementById("output").textContent = JSON.stringify(data, null, 2);
// }


async function loadMetrics() {
  const res = await fetch("http://localhost:9090/api/v1/query?query=your_metric_here");
  const data = await res.json();
  const result = data.data.result[0];
  const value = result?.value[1] || 0;

  // return new Chart(document.getElementById("metricsChart"), {
  //   type: "bar",
  //   data: {
  //     labels: ["your_metric_here"],
  //     datasets: [{
  //       label: "Current Value",
  //       data: [value],
  //       backgroundColor: "#3e95cd"
  //     }]
  //   }
  // });
}

async function loadStatement() {
  const start = (document.getElementById("startDate") as HTMLInputElement).value;
  const end = (document.getElementById("endDate") as HTMLInputElement).value;

  const res: Response = await fetch(`http://localhost:3001/api/statements?start=${start}&end=${end}`);
  const data = JSON.parse(await res.json());
  const tbody = (document.getElementById("statementTable") as HTMLInputElement).querySelector("tbody")!;
  tbody.innerHTML = "";

  console.log(`${new Date().toLocaleString} received response ${JSON.stringify(data)}`)
  // data.forEach(tx => {
  //   const row = `<tr>
  //       <td>${tx.timestamp}</td>
  //       <td>${tx.amount}</td>
  //       <td>${tx.description}</td>
  //     </tr>`;
  //   tbody.innerHTML += row;
  // });
}

function downloadStatement() {
  fetch("/graphql", {
    method: "POST",
    headers: {
    "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: "{ hello }" }),
  })
    .then(response => response.json())
    .then(data => {
      console.log("Data returned:", data);
    })
    .catch(error => {
      console.error("Request failed:", error);
    });


  // request('https://api.spacex.land/graphql/', document1).then(res => console.log(`${new Date().toLocaleString} RECEIVED SHIT ${JSON.stringify(res)}`))

  // const rows = Array.from(document.querySelectorAll("#statementTable tbody tr"));
  // const lines = rows.map(row => {
  //   const cols = row.querySelectorAll("td");
  //   return `${cols[0].innerText} | ${cols[1].innerText} | ${cols[2].innerText}`;
  // });
  // const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  // const a = document.createElement("a");
  // a.href = URL.createObjectURL(blob);
  // a.download = "bank_statement.txt";
  // a.click();
}

document.getElementById("b_bank_statement")!.addEventListener('click', () => loadStatement())
document.getElementById("b_download")!.addEventListener('click', () => downloadStatement())

loadMetrics();