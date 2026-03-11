Tests are deployed with the "run_tests.yaml" file configuration file for docker compose.

Most of them are made to test how data is written to the database.

But also there is a component test in the "tester" folder that runs whole pipeline using GrqphQL service for its orchestration. The test plan is to generate some transactions and use generation metadata to validate results. Metadata is attached to transaction records and also the generation summary is report is sent upon request.