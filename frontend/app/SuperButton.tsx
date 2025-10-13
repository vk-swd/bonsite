import React, { Children, useRef, useState } from "react";
import Button from '@mui/material/Button';

export function renderMenuButton(label: string, show: boolean, refreshOptions: () => void) {
    if (!show) {
      return <div></div>
    } else {
      return <div
          style={{
            borderTop: "1px solid #ccc",
            padding: "0px 0px",
            textAlign: "center",
            background: "#f9f9f9",
          }}
        >
          <Button
            size="small"
            onClick={e => {
              e.stopPropagation();  // prevent menu from closing
              refreshOptions();
            }}
          >
            {label}
          </Button>
        </div>
      }
    }