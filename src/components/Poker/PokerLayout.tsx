import React from 'react';

const PokerLayout: React.FC = () => {
    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: '#f0f0f0' }}>
            <header style={{ padding: '20px', backgroundColor: '#4CAF50', color: 'white', width: '100%', textAlign: 'center' }}>
                <h1>Welcome to Poker Game</h1>
            </header>
            <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <div style={{ border: '2px solid #4CAF50', borderRadius: '10px', padding: '20px', backgroundColor: 'white' }}>
                    <h2>Game Table</h2>
                    {/* Game components will be added here */}
                </div>
            </main>
            <footer style={{ padding: '10px', backgroundColor: '#4CAF50', color: 'white', width: '100%', textAlign: 'center' }}>
                <p>© 2023 Poker Game</p>
            </footer>
        </div>
    );
};

export default PokerLayout;