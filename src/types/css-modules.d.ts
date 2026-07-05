declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.module.scss' {
  const classes: { [key: string]: string };
  export default classes;
}

// Plain (side-effect) style imports, e.g. `import './styles.scss'`
declare module '*.scss';
declare module '*.css';
