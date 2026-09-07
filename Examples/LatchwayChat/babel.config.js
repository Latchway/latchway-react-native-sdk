module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Avoid Babel's pre-constructor instanceof check before LangChain fields exist.
  // Classes must still be constructed with new.
  assumptions: {noClassCalls: true},
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
