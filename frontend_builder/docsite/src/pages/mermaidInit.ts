// src/js/mermaid-theme.js
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  themeVariables: {
    primaryColor: '#81b111',
    primaryBorderColor: '#060458',
    actorBorder: '#000000',
    lineColor: '#333333',
    textColor: '#baabab',
    noteBackground: '#fff5ad',
    noteBorder: '#e5083c',
    fontFamily: 'trebuchet ms, verdana, arial, sans-serif',
    fontSize: '16px'
  }
});