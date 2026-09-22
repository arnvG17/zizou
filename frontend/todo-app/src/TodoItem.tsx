import React from 'react';

interface TodoItemProps {
    title: string;
    completed: boolean;
    onToggle: () => void;
}

const TodoItem: React.FC<TodoItemProps> = ({ title, completed, onToggle }) => {
    return (
        <div>
            <input type="checkbox" checked={completed} onChange={onToggle} />
            <span style={{ textDecoration: completed ? 'line-through' : 'none' }}>{title}</span>
        </div>
    );
};

export default TodoItem;
