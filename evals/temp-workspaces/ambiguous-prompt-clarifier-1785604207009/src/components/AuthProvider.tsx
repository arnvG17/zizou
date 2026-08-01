import React from 'react';
import { AuthProvider } from '../context/AuthContext';

const withAuth = (Component) => {
  return (props) => (
    <AuthProvider>
      <Component {...props} />
    </AuthProvider>
  );
};

export default withAuth;
