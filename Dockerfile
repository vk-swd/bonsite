FROM node:20-slim


ENTRYPOINT ["/bin/bash", "-c"]


RUN ls -lsa ./
RUN echo "AAAAAAAAAAAAAAAAAA===========AAAAAAAAAAAAAAAAAAAA"


# CMD [ "-c", "/bin/whoami && /bin/bash" ]
