import { json } from 'stream/consumers';

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
}

document.getElementById("b_bank_statement")!.addEventListener('click', () => loadStatement())
document.getElementById("b_download")!.addEventListener('click', () => downloadStatement())
document.getElementById("input_button")!.addEventListener('click', () => {
  const id = (document.getElementById("input1") as HTMLInputElement)!.value;
  // const name = (document.getElementById("input2") as HTMLInputElement)!.value;
  // const color = (document.getElementById("input3") as HTMLInputElement)!.value;
  // const hairlen = (document.getElementById("input4") as HTMLInputElement)!.value;
  // const piercing = (document.getElementById("input5") as HTMLInputElement)!.value;
  fetch("/graphql", {
    method: "POST",
    headers: {
    "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: id}),
    //`mutation { addFace({id: ${id},name: ${name},color: ${color}, hairLen: ${hairlen}}) }`
  })
    .then(response => response.json())
    .then(data => {
      console.log("Data returned 1:", data);
    })
    .catch(error => {
      console.error("Request failed:", error);
    });
})
document.getElementById("get_face")!.addEventListener('click', () => {
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
      console.log("Data returned 1:", data);
    })
    .catch(error => {
      console.error("Request failed:", error);
    });
})

const genButton = document.getElementById("gen_button")!
genButton.addEventListener('click', () => {
  let query = "";
  if (genButton.dataset.isStarted == "true") {
    genButton.dataset.isStarted = "false";
    genButton.textContent = "Start Gen"
    query = `{ stopGen }`
  } else {
    genButton.textContent = "Started Gen"
    genButton.dataset.isStarted = "true";
    query = `{ startGen(params: {userCount: ${1}, 
      maxTransactionsPerDay: ${1}, 
      generationIntervalMs: ${1}}) }`
  }

  fetch("/graphql", {
    method: "POST",
    headers: {
    "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query }),
  })  
})



loadMetrics();