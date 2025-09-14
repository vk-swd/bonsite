import { json } from 'stream/consumers';
import { GenParameters, RequestResultValidator } from "./common/generator_parameters";

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
const getValyeElement = (id: string): HTMLInputElement => {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Element with id ${id} not found`);
  }
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Element with id ${id} is not an HTMLInputElement`);
  }
  return element;
};
async function loadStatement() {
  const start = getValyeElement("startDate").value;
  const end = getValyeElement("endDate").value;

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
}

document.getElementById("b_bank_statement")!.addEventListener('click', () => loadStatement())
document.getElementById("b_download")!.addEventListener('click', () => downloadStatement())

const testButt = document.getElementById("test_butt")!
testButt.addEventListener('click', () => {
  
  const  query = `{ getProgress {
    ... on ProgressReport {
      totalSent
      totalUsers
      isRunning
      percentComplete
    }
    ... on Result {
      status
      message
      data
    }
  }}`
  const  query1 = `{ query: { hello} }`
  console.log(`query is ${JSON.stringify(query)}`);
  fetch("/graphql", {
    method: "POST",
    headers: {
    "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  }).then(response => 
    {
      console.log(`Response status: ${JSON.stringify(response.body)}`);
      return response.text()
  })
    .then(data => {

      console.log(`Response status: ${JSON.stringify(data)}`);
      // const results = RequestResultValidator.parse(genButton.dataset.isStarted == "true" ? data.data.startGen : data.data.stopGen);
    })
    .catch(error => {
      console.error("Request failed:", error);
    });


})
const genButton = document.getElementById("gen_button")!
genButton.addEventListener('click', () => {
  let query = "";
  // if (genButton.dataset.isStarted == "true") {
  //   genButton.dataset.isStarted = "false";
  //   genButton.textContent = "Start Gen"
  //   query = `{ stopGen {status, message, data}}`
  // } else {
  //   const params: GenParameters = {
  //     userCount: parseInt(getValyeElement("userCountInput").value),
  //     generationIntervalMs: parseInt(getValyeElement("genIntervalInput").value),
  //     maxDelayMs: parseInt(getValyeElement("maxdelayInput").value),
  //     transactionCount: parseInt(getValyeElement("msgCountInput").value)
  //   };
  //   genButton.textContent = "Started Gen"
  //   genButton.dataset.isStarted = "true";
  //   query = `{ startGen(params: ${JSON.stringify(params).replace(/"/g, "")}) {status, message, data}  }`
  // }
  console.log(`query is ${query}`);
  fetch("/graphql", {
    method: "POST",
    headers: {
    "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  }).then(response => response.json())
    .then(data => {
      const results = RequestResultValidator.parse(genButton.dataset.isStarted == "true" ? data.data.startGen : data.data.stopGen);
    })
    .catch(error => {
      console.error("Request failed:", error);
    });
})



// loadMetrics();