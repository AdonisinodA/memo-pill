/** @type {import('tailwindcss').Config} */
module.exports = {
  // O JS também entra na varredura: as classes de saída do toast só existem
  // em /public/js/app.js e sem isto o Tailwind não as geraria.
  content: ['./views/**/*.hbs', './public/js/**/*.js'],
  theme: { extend: {} },
  plugins: [],
};
