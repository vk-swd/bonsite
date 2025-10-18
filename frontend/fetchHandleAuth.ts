import { ApiError, ApiErrorType } from "./common/gqlDeclarations";
import { logger } from "./common/logger";

export function getClientId() {
  let id = localStorage.getItem('clientId');
  if (id == null || id == undefined || id == "undefined") {
    id = crypto.randomUUID?.() || (
      Date.now().toString(36) + Math.random().toString(36).slice(2)
    );
    localStorage.setItem('clientId', id);
  }
  return id;
}

export function fetchHandleAuth<P, R>(fetcher: (...params: any) => Promise<R>, ...params: any): Promise<R> {
    return fetcher(...params, getClientId()).then(response => {
        return response;
    }).catch(error => {
        let temp = error;
        while (temp instanceof ApiError) {
            logger.log("fetchHandleAuth unwrapping ApiError", JSON.stringify(temp), 
            temp.type == ApiErrorType.NOT_AUTHENTICATED, temp.prevError instanceof ApiError);
            if (temp.type == ApiErrorType.NOT_AUTHENTICATED) {
                alert("Session expired");
                window.location.href = "/login.html";
                throw temp;
            }
            temp = temp.prevError;
        }
        throw error;
    });
}

export function fetchHandleAuthLogin<P, R>(fetcher: (...params: any) => Promise<R>, ...params: any): Promise<R> {
  return fetcher(...params, getClientId()).then(response => {
      return response;
  })
}