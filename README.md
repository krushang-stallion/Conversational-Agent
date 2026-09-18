# Sphere Visualization

A real-time 3D sphere visualization project using Three.js (Frontend) and WebSockets (Backend).

## Prerequisites

To run this project, you will need the following installed on your machine:
- [Node.js](https://nodejs.org/en/download/) (v16.0.0 or higher recommended)
- `npm` (comes with Node.js) or another package manager like `yarn` / `pnpm`
- [Git](https://git-scm.com/downloads)

## Project Structure

This is a full-stack setup containing two main components:
- `frontend/`: A Vite + TypeScript + Three.js web application.
- `backend/`: A Node.js + TypeScript WebSocket server.

## Getting Started

### 1. Clone the repository
```bash
git clone https://github.com/stalliondeveloper-dev/Sphere-Visualization.git
cd Sphere-Visualization
```

### 2. Run the Backend WebSocket Server
Open a terminal and run the following commands to start the backend server:
```bash
cd backend
npm install
npm start
```
The backend server will start listening for WebSocket connections.

### 3. Run the Frontend Development Server
Open a **new** terminal window or tab, and run the following commands to start the frontend:
```bash
cd frontend
npm install
npm run dev
```
The Vite development server will start up. Open the Local URL provided in the terminal (usually `http://localhost:5173/`) in your browser to view the application.

## Technologies Used
- **Frontend**: Vite, TypeScript, Three.js
- **Backend**: Node.js, TypeScript, ws (WebSocket)
