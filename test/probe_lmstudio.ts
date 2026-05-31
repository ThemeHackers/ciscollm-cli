import axios from 'axios';

async function main() {
    console.log("Probing LM Studio v1 APIs on port 1234...");
    const modelToLoad = "qwen3.5-4b";


    try {
        console.log(`\n1. Attempting to load model "${modelToLoad}" via POST /api/v1/models/load...`);
        const res = await axios.post('http://127.0.0.1:1234/api/v1/models/load', {
            model: modelToLoad
        }, { timeout: 15000 });
        console.log("Load model SUCCESS:");
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e: any) {
        console.log("Load model FAILED:", e.message);
        if (e.response) {
            console.log("Status:", e.response.status);
            console.log("Body:", e.response.data);
        }
        return;
    }


    try {
        console.log(`\n2. Running completion test with "${modelToLoad}"...`);
        const res = await axios.post('http://127.0.0.1:1234/v1/chat/completions', {
            model: modelToLoad,
            messages: [{ role: "user", content: "hello" }]
        });
        console.log("chat/completions SUCCESS:");
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e: any) {
        console.log("chat/completions FAILED:", e.message);
        if (e.response) {
            console.log("Status:", e.response.status);
            console.log("Body:", e.response.data);
        }
    }
}

main();
