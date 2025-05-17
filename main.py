import os
import json
import logging
import hashlib
import numpy as np
from datetime import datetime
from typing import List, Dict, Optional, Any, Union
import time

import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from tqdm import tqdm
import torch
from sentence_transformers import SentenceTransformer, CrossEncoder
import chromadb
from chromadb.utils import embedding_functions
from rank_bm25 import BM25Okapi
import nltk
from nltk.tokenize import word_tokenize
from nltk.corpus import stopwords

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("RAGZ")

# Load environment variables
load_dotenv()

# Constants
DOCUMENTS_FILE = "./documents.json"
CHROMADB_DIR = "./chromadb"
EMBEDDING_MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
CROSS_ENCODER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"
COLLECTION_NAME = "documents"
BM25_WEIGHT = 0.3
SEMANTIC_WEIGHT = 0.7
MAX_RESULTS = 20

# Download NLTK resources if not present
nltk.download('punkt', quiet=True)
nltk.download('stopwords', quiet=True)

# Request models
class SearchRequest(BaseModel):
    query: str
    from_date: Optional[str] = None
    to_date: Optional[str] = None
    correspondent: Optional[str] = None

# Response models
class SearchResult(BaseModel):
    title: str
    correspondent: str
    date: str
    score: float
    cross_score: float
    snippet: str
    doc_id: Optional[int] = None

# Data Manager
class DataManager:
    def __init__(self):
        self.paperless_url = os.getenv("PAPERLESS_URL")
        self.paperless_token = os.getenv("PAPERLESS_TOKEN")
        
        if not self.paperless_url or not self.paperless_token:
            logger.error("Missing PAPERLESS_URL or PAPERLESS_TOKEN in .env file")
            raise ValueError("Missing PAPERLESS_URL or PAPERLESS_TOKEN in .env file")
        
        self.documents = []
        self.document_hashes = {}
        self.last_sync = None
        
        # Set up ChromaDB
        self.chroma_client = chromadb.PersistentClient(path=CHROMADB_DIR)
        self.sentence_transformer = SentenceTransformer(EMBEDDING_MODEL_NAME)
        self.embedding_function = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name=EMBEDDING_MODEL_NAME
        )
        
        # Initialize Cross-Encoder
        self.cross_encoder = CrossEncoder(CROSS_ENCODER_MODEL_NAME)
    
    def _get_headers(self):
        return {"Authorization": f"Token {self.paperless_token}"}
    
    def _compute_document_hash(self, doc):
        """Compute a hash for a document to track changes"""
        content = f"{doc['title']}{doc['content']}{doc['correspondent']}"
        return hashlib.sha256(content.encode()).hexdigest()
    
    def fetch_documents_from_api(self):
        """Fetch all documents from Paperless-NGX API with pagination"""
        logger.info(f"Fetching documents from Paperless-NGX API: {self.paperless_url}")
        
        documents = []
        page = 1
        has_next = True
        
        while has_next:
            logger.info(f"Fetching page {page}")
            try:
                url = f"{self.paperless_url}/api/documents/?page={page}&page_size=100"
                logger.info(f"Making request to: {url}")
                
                response = requests.get(
                    url,
                    headers=self._get_headers(),
                    timeout=30
                )
                
                # Log response information for debugging
                logger.info(f"Response status code: {response.status_code}")
                logger.info(f"Response headers: {response.headers}")
                
                if response.status_code != 200:
                    logger.error(f"Failed to fetch documents: {response.status_code} - {response.text}")
                    raise Exception(f"API error: {response.status_code} - {response.text}")
                
                # Check if response is empty
                if not response.text:
                    logger.error("API returned empty response")
                    raise Exception("API returned empty response")
                
                # Log the beginning of the response for debugging
                response_preview = response.text[:200] + "..." if len(response.text) > 200 else response.text
                logger.info(f"Response content preview: {response_preview}")
                
                try:
                    data = response.json()
                except requests.exceptions.JSONDecodeError as e:
                    logger.error(f"JSON decode error: {str(e)}")
                    logger.error(f"Response content: {response.text}")
                    raise Exception(f"Could not parse API response as JSON: {str(e)}")
                
                results = data.get("results", [])
                documents.extend(results)
                
                # Check if there's a next page
                if data.get("next"):
                    page += 1
                else:
                    has_next = False
                    
            except requests.exceptions.RequestException as e:
                logger.error(f"Request error: {str(e)}")
                raise Exception(f"API request failed: {str(e)}")
        
        # Process documents to extract required fields
        processed_docs = []
        for doc in tqdm(documents, desc="Processing documents"):
            # Fetch document content if not included in listing
            if "content" not in doc or not doc["content"]:
                content_response = requests.get(
                    f"{self.paperless_url}/api/documents/{doc['id']}/download/txt/",
                    headers=self._get_headers(),
                    timeout=30
                )
                
                if content_response.status_code == 200:
                    content = content_response.text
                else:
                    logger.warning(f"Could not fetch content for document {doc['id']}")
                    content = ""
            else:
                content = doc.get("content", "")
            
            # Get correspondent name
            correspondent = ""
            if doc.get("correspondent"):
                corr_id = doc["correspondent"]
                corr_response = requests.get(
                    f"{self.paperless_url}/api/correspondents/{corr_id}/",
                    headers=self._get_headers(),
                    timeout=10
                )
                
                if corr_response.status_code == 200:
                    correspondent = corr_response.json().get("name", "")
            
            # Get tag names
            tags = []
            if doc.get("tags"):
                for tag_id in doc["tags"]:
                    tag_response = requests.get(
                        f"{self.paperless_url}/api/tags/{tag_id}/",
                        headers=self._get_headers(),
                        timeout=10
                    )
                    
                    if tag_response.status_code == 200:
                        tags.append(tag_response.json().get("name", ""))
            
            # Create processed document
            processed_doc = {
                "id": doc.get("id"),
                "title": doc.get("title", ""),
                "content": content,
                "correspondent": correspondent,
                "created": doc.get("created_date", doc.get("created", "")),
                "tags": tags,
                "last_updated": doc.get("modified", "")
            }
            
            # Compute document hash
            processed_doc["hash"] = self._compute_document_hash(processed_doc)
            processed_docs.append(processed_doc)
        
        return processed_docs
    
    def load_documents(self):
        """Load documents from file or API"""
        if os.path.exists(DOCUMENTS_FILE):
            logger.info(f"Loading documents from {DOCUMENTS_FILE}")
            with open(DOCUMENTS_FILE, 'r', encoding='utf-8') as f:
                local_documents = json.load(f)
            
            # Load document hashes
            self.document_hashes = {doc["id"]: doc["hash"] for doc in local_documents if "hash" in doc}
            self.last_sync = datetime.now().isoformat()
            
            # Check for updates if we have internet connection
            try:
                new_documents = self.fetch_documents_from_api()
                
                # Check for changes
                changes = False
                documents_dict = {doc["id"]: doc for doc in local_documents}
                
                # Process new or updated documents
                for doc in new_documents:
                    doc_id = doc["id"]
                    if doc_id not in documents_dict or doc["hash"] != self.document_hashes.get(doc_id):
                        logger.info(f"Found new or updated document: {doc['title']} (ID: {doc_id})")
                        documents_dict[doc_id] = doc
                        changes = True
                
                if changes:
                    logger.info("Saving updated documents")
                    self.documents = list(documents_dict.values())
                    self.save_documents()
                    return self.documents
                else:
                    logger.info("No document changes detected")
                    return local_documents
                    
            except Exception as e:
                logger.warning(f"Could not check for updates, using local documents: {str(e)}")
                return local_documents
        else:
            logger.info("No local documents found, fetching from API")
            self.documents = self.fetch_documents_from_api()
            self.save_documents()
            return self.documents
    
    def save_documents(self):
        """Save documents to file"""
        with open(DOCUMENTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.documents, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved {len(self.documents)} documents to {DOCUMENTS_FILE}")
    
    def setup_chroma_collection(self):
        """Set up ChromaDB collection"""
        # Check if collection exists
        try:
            existing_collections = self.chroma_client.list_collections()
            collection_exists = any(c.name == COLLECTION_NAME for c in existing_collections)
            
            if collection_exists:
                collection = self.chroma_client.get_collection(
                    name=COLLECTION_NAME,
                    embedding_function=self.embedding_function
                )
                logger.info(f"Loaded existing ChromaDB collection '{COLLECTION_NAME}'")
                
                # Check if we need to update the collection
                if not self.documents:
                    self.load_documents()
                
                existing_ids = collection.get()["ids"]
                existing_ids_set = set(existing_ids)
                
                # Find documents to add or update
                docs_to_update = []
                for doc in self.documents:
                    doc_id = str(doc["id"])
                    
                    # If document is new or hash has changed
                    if doc_id not in existing_ids_set or self.document_hashes.get(doc["id"]) != doc.get("hash"):
                        docs_to_update.append(doc)
                
                # Update documents if needed
                if docs_to_update:
                    logger.info(f"Updating {len(docs_to_update)} documents in ChromaDB")
                    self._add_documents_to_chroma(collection, docs_to_update)
                else:
                    logger.info("No updates needed for ChromaDB collection")
                
                return collection
            else:
                logger.info(f"Creating new ChromaDB collection '{COLLECTION_NAME}'")
                collection = self.chroma_client.create_collection(
                    name=COLLECTION_NAME,
                    embedding_function=self.embedding_function
                )
                
                # Load documents if not already loaded
                if not self.documents:
                    self.load_documents()
                
                # Add all documents to collection
                self._add_documents_to_chroma(collection, self.documents)
                return collection
                
        except Exception as e:
            logger.error(f"Error setting up ChromaDB collection: {str(e)}")
            raise
    
    def _add_documents_to_chroma(self, collection, documents):
        """Add documents to ChromaDB collection"""
        # We process in batches to avoid memory issues
        batch_size = 100
        total_docs = len(documents)
        
        for i in range(0, total_docs, batch_size):
            batch = documents[i:i+batch_size]
            logger.info(f"Processing batch {i//batch_size + 1}/{(total_docs-1)//batch_size + 1} ({len(batch)} documents)")
            
            ids = [str(doc["id"]) for doc in batch]
            
            # Prepare texts for embedding
            texts = [
                f"{doc['title']} {doc['correspondent']} {doc['content']}"
                for doc in batch
            ]
            
            # Prepare metadata
            metadatas = [
                {
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "created": doc["created"],
                    "tags": ", ".join(doc["tags"]),
                    "hash": doc["hash"]
                }
                for doc in batch
            ]
            
            # Add or update documents in collection
            collection.upsert(
                ids=ids,
                documents=texts,
                metadatas=metadatas
            )
        
        logger.info(f"Added/updated {total_docs} documents to ChromaDB collection")


# Search Engine
class SearchEngine:
    def __init__(self, data_manager):
        self.data_manager = data_manager
        self.collection = None
        self.documents = None
        self.bm25 = None
        self.tokenized_corpus = None
    
    def initialize(self):
        """Initialize search engine"""
        # Load documents if not already loaded
        if not self.data_manager.documents:
            self.documents = self.data_manager.load_documents()
        else:
            self.documents = self.data_manager.documents
        
        # Set up ChromaDB collection
        self.collection = self.data_manager.setup_chroma_collection()
        
        # Set up BM25
        logger.info("Initializing BM25 index")
        self._setup_bm25()
        
        logger.info("Search engine initialized")
    
    def _setup_bm25(self):
        """Set up BM25 index"""
        # Prepare corpus for BM25
        self.tokenized_corpus = []
        
        # Get stopwords for multiple languages
        stop_words = set()
        for lang in ['english', 'german', 'french', 'spanish', 'italian']:
            try:
                stop_words.update(stopwords.words(lang))
            except:
                pass
        
        # Tokenize documents
        for doc in tqdm(self.documents, desc="Tokenizing documents for BM25"):
            # Combine title, correspondent and content for search
            text = f"{doc['title']} {doc['correspondent']} {doc['content']}"
            
            # Tokenize and filter stopwords
            tokens = word_tokenize(text.lower())
            filtered_tokens = [token for token in tokens if token not in stop_words]
            
            self.tokenized_corpus.append(filtered_tokens)
        
        # Create BM25 index
        self.bm25 = BM25Okapi(self.tokenized_corpus)
    
    def keyword_search(self, query, top_k=MAX_RESULTS):
        """Perform keyword search using BM25"""
        # Tokenize query
        query_tokens = word_tokenize(query.lower())
        
        # Get BM25 scores
        scores = self.bm25.get_scores(query_tokens)
        
        # Get document indices sorted by score
        doc_scores = [(i, score) for i, score in enumerate(scores)]
        doc_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Get top-k documents
        results = []
        for i, score in doc_scores[:top_k]:
            if score > 0:  # Only include documents with non-zero scores
                doc = self.documents[i]
                results.append({
                    "id": doc["id"],
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "date": doc["created"],
                    "score": float(score),
                    "content": doc["content"]
                })
        
        return results
    
    def semantic_search(self, query, top_k=MAX_RESULTS):
        """Perform semantic search using ChromaDB"""
        results = self.collection.query(
            query_texts=[query],
            n_results=top_k
        )
        
        documents = []
        for i, doc_id in enumerate(results["ids"][0]):
            # Find the document in our list
            doc = next((d for d in self.documents if str(d["id"]) == doc_id), None)
            
            if doc:
                documents.append({
                    "id": doc["id"],
                    "title": doc["title"],
                    "correspondent": doc["correspondent"],
                    "date": doc["created"],
                    "score": float(results["distances"][0][i]) if "distances" in results else 1.0,
                    "content": doc["content"]
                })
        
        return documents
    
    def hybrid_search(self, query, top_k=MAX_RESULTS):
        """Perform hybrid search combining BM25 and semantic search"""
        # Get results from both search methods
        keyword_results = self.keyword_search(query, top_k=top_k*2)
        semantic_results = self.semantic_search(query, top_k=top_k*2)
        
        # Combine results
        results_map = {}
        
        # Normalize scores
        if keyword_results:
            max_keyword_score = max(r["score"] for r in keyword_results)
            for r in keyword_results:
                r["score"] = r["score"] / max_keyword_score if max_keyword_score > 0 else 0
        
        if semantic_results:
            # For semantic search, lower distance is better, so invert the score
            for r in semantic_results:
                # Convert distance to similarity score (1 - normalized_distance)
                r["score"] = 1 - r["score"] if r["score"] <= 1 else 0
        
        # Add keyword results with weight
        for result in keyword_results:
            doc_id = result["id"]
            results_map[doc_id] = {
                **result,
                "score": result["score"] * BM25_WEIGHT
            }
        
        # Add semantic results with weight
        for result in semantic_results:
            doc_id = result["id"]
            if doc_id in results_map:
                results_map[doc_id]["score"] += result["score"] * SEMANTIC_WEIGHT
            else:
                results_map[doc_id] = {
                    **result,
                    "score": result["score"] * SEMANTIC_WEIGHT
                }
        
        # Convert map to list and sort by score
        combined_results = list(results_map.values())
        combined_results.sort(key=lambda x: x["score"], reverse=True)
        
        return combined_results[:top_k]
    
    def rerank_results(self, query, results, top_k=MAX_RESULTS):
        """Rerank results using cross-encoder"""
        if not results:
            return []
        
        # Prepare pairs for cross-encoder
        pairs = [(query, result["title"] + " " + result["content"][:500]) for result in results]
        
        # Get cross-encoder scores
        cross_scores = self.data_manager.cross_encoder.predict(pairs)
        
        # Add cross-encoder scores to results
        for i, score in enumerate(cross_scores):
            # Convert score to a positive value by taking the sigmoid 
            # This maps any score to a value between 0 and 1
            # For cross-encoders, higher should be better matches
            norm_score = 1.0 / (1.0 + np.exp(-score))
            results[i]["cross_score"] = float(norm_score)
        
        # Sort by cross-encoder score
        results.sort(key=lambda x: x["cross_score"], reverse=True)
        
        return results[:top_k]
    
    def create_snippet(self, query, content, max_len=200):
        """Create a relevant snippet from the document content"""
        if not content:
            return ""
        
        # Get query terms
        query_terms = set(word_tokenize(query.lower()))
        
        # Split content into sentences
        sentences = content.split(". ")
        
        # Score sentences by number of query terms
        sentence_scores = []
        for sentence in sentences:
            sentence_terms = set(word_tokenize(sentence.lower()))
            score = len(query_terms.intersection(sentence_terms))
            sentence_scores.append((sentence, score))
        
        # Sort sentences by score
        sentence_scores.sort(key=lambda x: x[1], reverse=True)
        
        # Create snippet from top sentences
        snippet = ""
        for sentence, _ in sentence_scores:
            if len(snippet) + len(sentence) <= max_len:
                snippet += sentence + ". "
            else:
                break
        
        # If snippet is empty (no term matches), just use the beginning of the content
        if not snippet:
            snippet = content[:max_len] + "..."
        
        return snippet.strip()
    
    def search(self, request: SearchRequest):
        """Perform full search with filters and reranking"""
        query = request.query
        
        # Perform hybrid search
        results = self.hybrid_search(query)
        
        # Apply filters
        if request.from_date or request.to_date or request.correspondent:
            filtered_results = []
            for result in results:
                include = True
                
                # Filter by date range
                if request.from_date and result["date"]:
                    try:
                        doc_date = result["date"].split("T")[0]  # Get date part only
                        if doc_date < request.from_date:
                            include = False
                    except:
                        pass
                
                if request.to_date and result["date"]:
                    try:
                        doc_date = result["date"].split("T")[0]  # Get date part only
                        if doc_date > request.to_date:
                            include = False
                    except:
                        pass
                
                # Filter by correspondent
                if request.correspondent and result["correspondent"]:
                    if request.correspondent.lower() not in result["correspondent"].lower():
                        include = False
                
                if include:
                    filtered_results.append(result)
            
            results = filtered_results
        
        # Rerank results
        reranked_results = self.rerank_results(query, results)
        
        # Format results
        formatted_results = []
        for result in reranked_results:
            snippet = self.create_snippet(query, result["content"])
            
            formatted_results.append(SearchResult(
                title=result["title"],
                correspondent=result["correspondent"],
                date=result["date"],
                score=result["score"],
                cross_score=result["cross_score"],
                snippet=snippet,
                doc_id=result["id"]
            ))
        
        return formatted_results

# FastAPI Application
app = FastAPI(title="RAGZ Document Search API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize data manager and search engine
data_manager = None
search_engine = None

@app.on_event("startup")
async def startup_event():
    """Initialize data and search engine on startup"""
    global data_manager, search_engine
    
    logger.info("Starting RAGZ Document Search API")
    
    # Initialize data manager
    data_manager = DataManager()
    
    # Initialize search engine
    search_engine = SearchEngine(data_manager)
    search_engine.initialize()
    
    logger.info("RAGZ Document Search API ready")

@app.post("/search", response_model=List[SearchResult])
async def search_documents(request: SearchRequest):
    """Search documents with the given query and filters"""
    try:
        logger.info(f"Search request: {request}")
        return search_engine.search(request)
    except Exception as e:
        logger.error(f"Search error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

# Main entry point
if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
