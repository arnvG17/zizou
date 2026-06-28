const taskInput = document.getElementById('task');
const addBtn = document.getElementById('add');
const tasksList = document.getElementById('tasks');
const stepCounter = document.getElementById('step-counter');
const stepsDisplay = document.getElementById('steps');
const incrementStepsBtn = document.getElementById('increment-steps');
const decrementStepsBtn = document.getElementById('decrement-steps');
const calendar = document.getElementById('calendar');
const dateInput = document.getElementById('date');
const addDateBtn = document.getElementById('add-date');
const datesList = document.getElementById('dates');

let tasks = [];
let id = 0;
let steps = 0;
let dates = [];

addBtn.addEventListener('click', () => {
    const task = taskInput.value;
    if (task) {
        const newTask = { id: id++, task, completed: false };
        tasks.push(newTask);
        renderTasks();
        taskInput.value = '';
    }
});

incrementStepsBtn.addEventListener('click', () => {
    steps++;
    stepsDisplay.textContent = steps;
});

decrementStepsBtn.addEventListener('click', () => {
    if (steps > 0) {
        steps--;
        stepsDisplay.textContent = steps;
    }
});

addDateBtn.addEventListener('click', () => {
    const date = dateInput.value;
    if (date) {
        const newDate = { date };
        dates.push(newDate);
        renderDates();
        dateInput.value = '';
    }
});

function renderTasks() {
    const taskHTML = tasks.map((task) => {
        return `<li>
            <input type="checkbox" id="${task.id}" ${task.completed ? 'checked' : ''}>
            <span ${task.completed ? 'style="text-decoration: line-through"' : ''}>${task.task}</span>
            <button class="delete" data-id="${task.id}">Delete</button>
        </li>`;
    }).join('');
    tasksList.innerHTML = taskHTML;
}

function renderDates() {
    const dateHTML = dates.map((date) => {
        return `<li>${date.date}</li>`;
    }).join('');
    datesList.innerHTML = dateHTML;
}

tasksList.addEventListener('click', (e) => {
    if (e.target.classList.contains('delete')) {
        const id = parseInt(e.target.dataset.id);
        tasks = tasks.filter((task) => task.id !== id);
        renderTasks();
    } else if (e.target.type === 'checkbox') {
        const id = parseInt(e.target.id);
        tasks = tasks.map((task) => {
            if (task.id === id) {
                task.completed = !task.completed;
            }
            return task;
        });
        renderTasks();
    }
});