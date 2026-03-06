import TextField from '@mui/material/TextField';
import React, { Dispatch, SetStateAction } from 'react';

export function textInput<T>(lab: string, state: [T, Dispatch<SetStateAction<T>>]) {
    const type = typeof state[0] == 'number' ? "number" : "text"
    return <TextField
      fullWidth
      label={lab}
      value={state[0]}
      onChange={
        (e) => {
          if (type == "number") {
            const v = Number.parseInt(e.target.value);
            if (!isNaN(v)) {
              state[1](v as any);
            }
          } else {
            state[1](e.target.value as any);
          }
        }
      }
      type={type}
    />
  }