import React from 'react';
import { AuthProvider } from './context/AuthContext';
import YourMainComponent from './components/YourMainComponent'; // Replace this with your actual main component import
import Login from './components/Login';

const App = () => {
  return (
    <AuthProvider>
      <YourMainComponent />
      <Login />
    </AuthProvider>
  );
};

export default App;
