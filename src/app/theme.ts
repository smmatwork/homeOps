import { createTheme } from "@mui/material/styles";
 

// Configure typography to use a standard Roboto font stack.
const fontFamily = '"Roboto","Helvetica","Arial",sans-serif';

// Create a Material-UI theme with custom styles
const theme = createTheme({
  typography: {
    fontFamily,
  },
  palette: {
    mode: "light", // Default mode (can be toggled to "dark")
    background: {
      default: "#ffffff",
      paper: "#ffffff",
    },
    primary: {
      main: "#030213",
      contrastText: "#ffffff",
    },
    secondary: {
      main: "#ececf0",
      contrastText: "#030213",
    },
    error: {
      main: "#d4183d",
      contrastText: "#ffffff",
    },
    text: {
      primary: "rgba(0, 0, 0, 0.87)",
      secondary: "rgba(0, 0, 0, 0.6)",
    },
    divider: "rgba(0, 0, 0, 0.12)",
  },
  shape: {
    borderRadius: 10, // Equivalent to --radius
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          margin: 0,
          padding: 0,
          backgroundColor: "#ffffff",
          fontFamily,
        },
        a: {
          textDecoration: "none",
          color: "inherit",
        },
      },
    },
  },
  transitions: {
    duration: {
      shortest: 150,
      shorter: 200,
      short: 250,
      standard: 300,
      complex: 375,
      enteringScreen: 225,
      leavingScreen: 195,
    },
  },
});
export default theme;
