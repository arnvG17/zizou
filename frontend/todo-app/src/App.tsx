import React, { useState } from 'react';
import TodoList from './TodoList';
import TodoForm from './TodoForm';

const App: React.FC = () => {
  const [todos, setTodos] = useState<string[]>([]);

  const addTodo = (todo: string) => {
    setTodos([...todos, todo]);
  };

  return (
    <div>
      <h1>Todo App</h1>
      <TodoList todos={todos} />
      <TodoForm addTodo={addTodo} />
    </div>
  );
};

export default App;
