
#!/bin/sh


./compose.sh -f run_tests.yaml up tester ; ./compose.sh -f run_tests.yaml down -t 0