"use client";

import * as React from "react";
import {
  Dialog as MuiDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogProps,
  Button,
  Typography,
} from "@mui/material";

interface DialogPropsExtended extends DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  children,
  ...props
}: DialogPropsExtended) {
  return (
    <MuiDialog open={open} onClose={onClose} {...props}>
      {title ? (
        <DialogTitle>
          <Typography variant="h6" fontWeight="bold">
            {title}
          </Typography>
        </DialogTitle>
      ) : null}
      <DialogContent>
        {description && (
          <Typography variant="body2" color="textSecondary" mb={2}>
            {description}
          </Typography>
        )}
        {children}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} variant="outlined">
          {cancelText}
        </Button>
        {onConfirm && (
          <Button onClick={onConfirm} variant="contained" color="primary">
            {confirmText}
          </Button>
        )}
      </DialogActions>
    </MuiDialog>
  );
}

function DialogHeader({ children, ...props }: React.ComponentProps<"div">) {
  return (
    <div {...props}>
      {children}
    </div>
  );
}

function DialogDescription({ children, ...props }: React.ComponentProps<"div">) {
  return (
    <div {...props}>
      {children}
    </div>
  );
}

export { DialogTitle, DialogContent, DialogHeader, DialogDescription };